<?php
/**
 * Generic AI handler: conversation loop with ability execution.
 *
 * @package WP_AI_Chat
 */

defined( 'ABSPATH' ) || exit;

use WordPress\AiClient\Messages\DTO\Message;
use WordPress\AiClient\Messages\DTO\MessagePart;
use WordPress\AiClient\Messages\DTO\ModelMessage;
use WordPress\AiClient\Messages\DTO\UserMessage;
use WordPress\AiClient\Tools\DTO\FunctionCall;
use WordPress\AiClient\Tools\DTO\FunctionDeclaration;
use WordPress\AiClient\Tools\DTO\FunctionResponse;

/**
 * Class WP_AI_Chat_Handler.
 */
class WP_AI_Chat_Handler {

	const MAX_ITERATIONS = 15;
	const MAX_PROMPTS    = 100;
	const MAX_CHARS      = 400000;
	const META_KEY       = 'wp_ai_chat_conversation_state';

	/**
	 * Live progress tracker for the current request.
	 *
	 * @var WP_AI_Chat_Progress|null
	 */
	private $progress = null;

	/**
	 * Process a user prompt with AI (conversation loop + abilities).
	 *
	 * @param string     $prompt         User's message.
	 * @param array<int> $attachment_ids Optional. Image attachment IDs (requires image handler via filter).
	 * @param array|null $history        Optional. Client-provided history [ [ 'role' => 'user'|'assistant', 'content' => '...' ], ... ]. If null, loads from user meta.
	 * @param string     $progress_id    Optional. Client progress session ID for live status polling.
	 * @return array|WP_Error { response, actions?, model_info?, token_usage?, state? }
	 */
	public function process_prompt( string $prompt, array $attachment_ids = array(), ?array $history = null, string $progress_id = '' ) {
		if ( ! function_exists( 'wp_ai_client_prompt' ) ) {
			return new WP_Error( 'wp_ai_client_not_available', __( 'WordPress AI Client is not available (requires WordPress 7.0+).', 'wp-ai-chat' ) );
		}

		if ( ! $this->has_api_key() ) {
			return new WP_Error(
				'no_api_key',
				__( 'AI API key is not configured. Please configure your API credentials in Settings > AI Credentials.', 'wp-ai-chat' )
			);
		}

		$abilities = $this->get_abilities();
		$system_content = (string) apply_filters( 'wp_ai_chat_system_instruction', 'You are a helpful assistant.', $prompt, $history ?? array() );

		$message_parts = array( new MessagePart( $prompt ) );
		$message_parts = apply_filters( 'wp_ai_chat_user_message_parts', $message_parts, $prompt, $attachment_ids );
		$original_user_message = new UserMessage( $message_parts );

		$user_id      = get_current_user_id();
		$progress_id  = sanitize_key( $progress_id );

		if ( $user_id > 0 && '' !== $progress_id ) {
			$this->progress = new WP_AI_Chat_Progress( $user_id, $progress_id );
			$this->progress->start();
		}

		$use_state    = $user_id > 0 && null === $history;
		$state        = $use_state ? $this->get_conversation_state( $user_id ) : array( 'prompt_count' => 0, 'char_count' => 0, 'history' => array() );
		$prompt_count = $state['prompt_count'];
		$char_count   = $state['char_count'];

		$was_reset = false;
		if ( $use_state && ( $prompt_count >= self::MAX_PROMPTS || $char_count >= self::MAX_CHARS ) ) {
			$this->clear_conversation_state( $user_id );
			$state        = $this->get_conversation_state( $user_id );
			$prompt_count = 0;
			$char_count   = 0;
			$was_reset    = true;
		}

		++$prompt_count;
		$char_count += strlen( $prompt );

		if ( null !== $history ) {
			$existing_history = $this->history_array_to_messages( $history );
		} else {
			$existing_history = $this->load_history_from_state( $state['history'] );
		}

		$initial_messages = array_merge( $existing_history, array( $original_user_message ) );
		$builder           = wp_ai_client_prompt( $initial_messages );
		$builder->using_system_instruction( $system_content );

		$builder->using_model_preference(
			array( 'openai', 'gpt-4o-mini' ),
			array( 'openai', 'gpt-4o' ),
			array( 'openai', 'gpt-4.1-mini' ),
			array( 'openai', 'gpt-4.1' ),
			array( 'google', 'gemini-2.0-flash' ),
			array( 'google', 'gemini-2.5-flash' ),
			array( 'anthropic', 'claude-haiku-4-5' )
		);

		$function_declarations = array();
		foreach ( $abilities as $ability_name ) {
			$ability = function_exists( 'wp_get_ability' ) ? wp_get_ability( $ability_name ) : null;
			if ( ! $ability ) {
				continue;
			}
			$ability_name  = $ability->get_name();
			$function_name = 'wpab__' . str_replace( '/', '__', $ability_name );
			$input_schema  = $ability->get_input_schema();
			$schema_for_declaration = $this->normalize_schema_for_function_calling( $input_schema );

			// normalize_schema_for_function_calling() returns null both for a
			// genuinely parameterless ability and for one whose schema couldn't
			// be made OpenAI-safe. Only the first case is fine to send through —
			// the second would expose a function the model can call with no way
			// to pass required arguments, so skip it instead.
			if ( null === $schema_for_declaration && null !== $input_schema ) {
				continue;
			}

			$function_declarations[] = new FunctionDeclaration(
				$function_name,
				$ability->get_description(),
				$schema_for_declaration
			);
		}

		if ( ! empty( $function_declarations ) ) {
			$builder->using_function_declarations( ...$function_declarations );
		}

		$builder = apply_filters( 'wp_ai_chat_prompt_builder', $builder, $prompt, $history ?? array(), '' );

		$result = $this->process_conversation_loop(
			$builder,
			$original_user_message,
			$system_content,
			$function_declarations,
			$existing_history
		);

		if ( is_wp_error( $result ) ) {
			if ( $this->progress instanceof WP_AI_Chat_Progress ) {
				$this->progress->finish( 'error', $result->get_error_message() );
			}
			return $result;
		}

		if ( $this->progress instanceof WP_AI_Chat_Progress ) {
			$this->progress->finish( 'complete', __( 'Response ready.', 'wp-ai-chat' ) );
		}

		$response_text = $result['response'] ?? '';
		$char_count   += strlen( $response_text );

		if ( $use_state ) {
			$updated_history = $this->append_to_history( $state['history'], $original_user_message, $result );
			$this->save_conversation_state( $user_id, array(
				'prompt_count' => $prompt_count,
				'char_count'  => $char_count,
				'history'     => $updated_history,
			) );
		}

		$result['state'] = array(
			'prompt_count' => $prompt_count,
			'char_count'   => $char_count,
			'max_prompts'  => self::MAX_PROMPTS,
			'max_chars'    => self::MAX_CHARS,
		);
		if ( $was_reset ) {
			$result['was_reset'] = true;
		}

		return $result;
	}

	/**
	 * Reshape an ability's input schema into something OpenAI's function-calling
	 * API will actually accept.
	 *
	 * OpenAI rejects any schema with oneOf/anyOf/allOf/enum/const/not at the top
	 * level, even alongside a valid "type": "object" (e.g. WordPress core's
	 * read-users and read-content abilities, which use a top-level oneOf to
	 * express "look this up by id, OR by email, OR by username, OR list them").
	 * Each branch of those is itself a valid object schema, so this flattens
	 * them into one object schema with the union of every branch's properties,
	 * dropping the per-branch "required" constraint (OpenAI's schema dialect
	 * can't express "exactly one of these branches' required fields" anyway —
	 * the ability's own execute/permission callback is what actually validates
	 * a real call, so an under-specified call still fails safely there).
	 *
	 * @param array<string, mixed>|null $schema Ability input schema.
	 *
	 * @return array<string, mixed>|null Schema safe to hand to FunctionDeclaration,
	 *                                   or null for a parameterless ability.
	 */
	private function normalize_schema_for_function_calling( ?array $schema ): ?array {
		if ( null === $schema ) {
			return null;
		}

		$union_keys = array( 'oneOf', 'anyOf' );
		$union_key  = null;

		foreach ( $union_keys as $key ) {
			if ( isset( $schema[ $key ] ) && is_array( $schema[ $key ] ) ) {
				$union_key = $key;
				break;
			}
		}

		if ( null !== $union_key ) {
			$merged_properties = array();

			foreach ( $schema[ $union_key ] as $branch ) {
				if ( isset( $branch['properties'] ) && is_array( $branch['properties'] ) ) {
					$merged_properties = array_merge( $merged_properties, $branch['properties'] );
				}
			}

			$schema = array(
				'type'                 => 'object',
				'properties'           => $merged_properties,
				'additionalProperties' => false,
			);
		}

		// allOf/enum/const/not at the schema root aren't ones any current core
		// or GatherPress ability actually uses, and there's no generically
		// correct way to flatten them into an object schema — skip rather than
		// send something guaranteed to 400 and take the whole batch down with it.
		$still_disallowed = array( 'allOf', 'enum', 'const', 'not' );

		if ( array_intersect_key( array_flip( $still_disallowed ), $schema ) ) {
			return null;
		}

		if ( ! isset( $schema['type'] ) || 'object' !== $schema['type'] ) {
			return null;
		}

		if ( empty( $schema['properties'] ) ) {
			$schema['properties'] = new \stdClass();
		}

		return $schema;
	}

	/**
	 * Get abilities to use from the global Abilities API.
	 *
	 * This reads all registered abilities via wp_get_abilities()
	 * so anything registered by plugins like AI Experiments will be
	 * available to this assistant.
	 *
	 * @return array<string> List of ability names (slugs).
	 */
	private function get_abilities(): array {
		if ( ! function_exists( 'wp_get_abilities' ) ) {
			return array();
		}

		$abilities     = wp_get_abilities();
		$ability_names = array();

		foreach ( $abilities as $ability ) {
			if ( is_object( $ability ) && method_exists( $ability, 'get_name' ) ) {
				$ability_names[] = $ability->get_name();
			}
		}

		return $ability_names;
	}

	/**
	 * Public helper: get registered ability names (for UI/debug).
	 *
	 * @return array<string>
	 */
	public function get_registered_abilities(): array {
		return $this->get_abilities();
	}

	/**
	 * Process conversation loop with function calling.
	 *
	 * @param object $builder WordPress core prompt builder from wp_ai_client_prompt() (WP 7.0+).
	 */
	private function process_conversation_loop(
		$builder,
		UserMessage $original_user_message,
		string $system_instruction,
		array $function_declarations,
		array $existing_history = array()
	) {
		$actions_taken        = array();
		$iterations           = 0;
		$conversation_history = array();
		$model_info           = null;
		$total_prompt_tokens  = 0;
		$total_completion_tokens = 0;
		$total_tokens         = 0;

		while ( $iterations < self::MAX_ITERATIONS ) {
			++$iterations;

			if ( $this->progress instanceof WP_AI_Chat_Progress ) {
				$this->progress->add_entry(
					'iteration_start',
					sprintf(
						/* translators: 1: current iteration number, 2: max iterations */
						__( 'Iteration %1$d of %2$d — waiting for model…', 'wp-ai-chat' ),
						$iterations,
						self::MAX_ITERATIONS
					),
					array( 'iteration' => $iterations )
				);
			}

			$result = $builder->generate_result();
			if ( is_wp_error( $result ) ) {
				if ( $this->progress instanceof WP_AI_Chat_Progress ) {
					$this->progress->finish( 'error', $result->get_error_message() );
				}
				return $this->handle_generate_result_error( $result );
			}

			$candidates = $result->getCandidates();
			if ( empty( $candidates ) ) {
				if ( $this->progress instanceof WP_AI_Chat_Progress ) {
					$this->progress->finish( 'error', __( 'AI model returned no candidates.', 'wp-ai-chat' ) );
				}
				return new WP_Error( 'no_candidates', __( 'AI model returned no candidates.', 'wp-ai-chat' ) );
			}

			if ( null === $model_info ) {
				$provider_metadata = $result->getProviderMetadata();
				$model_metadata    = $result->getModelMetadata();
				$model_info        = array(
					'provider' => $provider_metadata->getName(),
					'model'    => $model_metadata->getName(),
				);
			}

			$token_usage = $result->getTokenUsage();
			$total_prompt_tokens     += $token_usage->getPromptTokens();
			$total_completion_tokens += $token_usage->getCompletionTokens();
			$total_tokens            += $token_usage->getTotalTokens();

			$message = $candidates[0]->getMessage();

			if ( ! $this->has_ability_calls( $message ) ) {
				$text_content = $this->extract_text_content( $message );
				$response_text = $text_content !== '' ? $text_content : __( 'Task completed!', 'wp-ai-chat' );

				if ( $this->progress instanceof WP_AI_Chat_Progress ) {
					$this->progress->add_entry(
						'model_response',
						__( 'Model returned a final response.', 'wp-ai-chat' ),
						array( 'iteration' => $iterations )
					);
				}

				$estimated_cost = ( $total_prompt_tokens / 1000 * 0.01 ) + ( $total_completion_tokens / 1000 * 0.03 );
				return array(
					'response'    => $response_text,
					'actions'     => $actions_taken,
					'model_info'  => $model_info,
					'token_usage' => array(
						'prompt_tokens'     => $total_prompt_tokens,
						'completion_tokens' => $total_completion_tokens,
						'total_tokens'      => $total_tokens,
						'estimated_cost'    => $estimated_cost,
					),
				);
			}

			$function_response_messages = array();
			foreach ( $message->getParts() as $part ) {
				if ( $part->getType()->isFunctionCall() ) {
					$function_call = $part->getFunctionCall();
					if ( $function_call instanceof FunctionCall && $this->is_ability_call( $function_call ) ) {
						$function_name = $function_call->getName();
						$ability_name  = $this->function_name_to_ability_name( $function_name );
						$ability_args  = $function_call->getArgs();

						if ( $this->progress instanceof WP_AI_Chat_Progress && $ability_name ) {
							$this->progress->add_entry(
								'ability_start',
								sprintf(
									/* translators: %s: ability name */
									__( 'Calling ability: %s', 'wp-ai-chat' ),
									$ability_name
								),
									array(
										'iteration' => $iterations,
										'ability'   => $ability_name,
										'label'     => $this->get_ability_label( $ability_name ),
										'args'      => is_array( $ability_args ) ? $ability_args : array(),
									)
								);
							}

							$function_response = $this->execute_ability( $function_call );
							$function_response_messages[] = new UserMessage( array( new MessagePart( $function_response ) ) );
							$exec_result = $function_response->getResponse();

							if ( $ability_name ) {
								$debug_details = $this->extract_ability_debug_details( $exec_result );

								if ( $this->progress instanceof WP_AI_Chat_Progress ) {
									$this->progress->add_entry(
										'ability_done',
										sprintf(
											/* translators: 1: ability name, 2: result summary */
											__( 'Finished %1$s — %2$s', 'wp-ai-chat' ),
											$ability_name,
											$this->summarize_ability_result( $exec_result )
										),
										array(
											'iteration' => $iterations,
											'ability'   => $ability_name,
											'label'     => $this->get_ability_label( $ability_name ),
											'success'   => ! $this->ability_result_is_error( $exec_result ),
											'summary'   => $this->summarize_ability_result( $exec_result ),
											'details'   => $debug_details,
										)
									);
								}

							$actions_taken[] = array(
								'ability' => $ability_name,
								'label'   => $this->get_ability_label( $ability_name ),
								'args'    => $ability_args,
								'result'  => $exec_result,
							);
						}
					}
				}
			}

			$conversation_history[] = $message;
			$conversation_history   = array_merge( $conversation_history, $function_response_messages );

			$all_messages = array_merge( $existing_history, array( $original_user_message ) );
			$all_messages = array_merge( $all_messages, $conversation_history );
			$builder      = wp_ai_client_prompt( $all_messages );

			if ( '' !== $system_instruction ) {
				$builder->using_system_instruction( $system_instruction );
			}
			if ( ! empty( $function_declarations ) ) {
				$builder->using_function_declarations( ...$function_declarations );
			}
		}

		if ( $this->progress instanceof WP_AI_Chat_Progress ) {
			$this->progress->add_entry(
				'max_iterations',
				sprintf(
					/* translators: %d: max iteration count */
					__( 'Stopped: maximum conversation iterations (%d) reached.', 'wp-ai-chat' ),
					self::MAX_ITERATIONS
				),
				array( 'iteration' => $iterations )
			);
			$this->progress->finish(
				'error',
				sprintf(
					/* translators: %d: max iteration count */
					__( 'Maximum conversation iterations (%d) reached.', 'wp-ai-chat' ),
					self::MAX_ITERATIONS
				)
			);
		}

		return new WP_Error(
			'max_iterations',
			sprintf( __( 'Maximum conversation iterations (%d) reached.', 'wp-ai-chat' ), self::MAX_ITERATIONS ),
			array(
				'actions'   => $actions_taken,
				'iteration' => $iterations,
			)
		);
	}

	/**
	 * Human-readable ability label for the chat UI (e.g. "Import Google Doc"),
	 * falling back to the ability name.
	 *
	 * @param string $ability_name Ability name.
	 * @return string
	 */
	private function get_ability_label( string $ability_name ): string {
		$ability = function_exists( 'wp_get_ability' ) ? wp_get_ability( $ability_name ) : null;
		$label   = $ability ? (string) $ability->get_label() : '';
		return '' !== $label ? $label : $ability_name;
	}

	/**
	 * Whether an ability result payload represents an error.
	 *
	 * @param mixed $result Ability execution payload.
	 * @return bool
	 */
	private function ability_result_is_error( $result ): bool {
		if ( ! is_array( $result ) ) {
			return true;
		}

		if ( isset( $result['error'] ) && ! empty( $result['error'] ) ) {
			return true;
		}

		if ( array_key_exists( 'success', $result ) && false === $result['success'] ) {
			return true;
		}

		return false;
	}

	/**
	 * Build a short human-readable summary of an ability result for live progress.
	 *
	 * @param mixed $result Ability execution payload.
	 * @return string
	 */
	private function summarize_ability_result( $result ): string {
		if ( ! is_array( $result ) ) {
			return __( 'unexpected result', 'wp-ai-chat' );
		}

		if ( isset( $result['error'] ) && is_string( $result['error'] ) && '' !== $result['error'] ) {
			return sprintf(
				/* translators: %s: error message */
				__( 'error: %s', 'wp-ai-chat' ),
				wp_html_excerpt( $result['error'], 120, '…' )
			);
		}

		if ( isset( $result['message'] ) && is_string( $result['message'] ) && '' !== $result['message'] ) {
			return wp_html_excerpt( $result['message'], 120, '…' );
		}

		if ( array_key_exists( 'success', $result ) ) {
			return $result['success'] ? __( 'success', 'wp-ai-chat' ) : __( 'failed', 'wp-ai-chat' );
		}

		return __( 'done', 'wp-ai-chat' );
	}

	/**
	 * Prepare ability result payload for live debug output.
	 *
	 * Returns the full result array by default. Plugins may filter
	 * `wp_ai_chat_ability_debug_details` to trim or reshape output.
	 *
	 * @param mixed $result Ability execution payload.
	 * @return array<string, mixed>
	 */
	private function extract_ability_debug_details( $result ): array {
		if ( ! is_array( $result ) ) {
			return array();
		}

		/**
		 * Filters ability result details shown in live debug output.
		 *
		 * @since 1.0.8
		 *
		 * @param array $details Full ability result by default.
		 * @param array $result  Raw ability result.
		 */
		return apply_filters( 'wp_ai_chat_ability_debug_details', $result, $result );
	}

	/**
	 * Maps WP_Error from the prompt builder generate_result() to user-facing errors.
	 *
	 * Core wraps HTTP/SDK failures as WP_Error (e.g. prompt_client_error, prompt_invalid_argument).
	 *
	 * @param WP_Error $error Error from generate_result().
	 * @return WP_Error
	 */
	private function handle_generate_result_error( WP_Error $error ): WP_Error {
		$message = $error->get_error_message();
		$code    = $error->get_error_code();

		if ( 'prompt_invalid_argument' === $code && strpos( $message, 'No models found' ) !== false ) {
			return new WP_Error(
				'no_models_found',
				__( 'No AI models found. Please verify your API key in Settings → AI Credentials and try again.', 'wp-ai-chat' )
			);
		}

		$provider_name = '';
		if ( strpos( $message, 'api.google.com' ) !== false || strpos( $message, 'generativelanguage.googleapis.com' ) !== false ) {
			$provider_name = 'Google';
		} elseif ( strpos( $message, 'api.openai.com' ) !== false ) {
			$provider_name = 'OpenAI';
		} elseif ( strpos( $message, 'api.anthropic.com' ) !== false ) {
			$provider_name = 'Anthropic';
		}

		if ( strpos( $message, '429' ) !== false || strpos( $message, 'Too Many Requests' ) !== false ) {
			$error_msg = __( 'API rate limit exceeded. You may need to upgrade your API plan or check your quota limits.', 'wp-ai-chat' );
			if ( $provider_name ) {
				$error_msg = sprintf(
					/* translators: %s: AI provider name (e.g. OpenAI). */
					__( 'API rate limit exceeded for %s. Upgrade your API plan or check quota limits.', 'wp-ai-chat' ),
					$provider_name
				);
			}
			return new WP_Error( 'rate_limit', $error_msg );
		}

		if ( strpos( $message, '401' ) !== false || strpos( $message, 'Unauthorized' ) !== false ) {
			$error_msg = __( 'Invalid API credentials. Please check your API key in Settings > AI Credentials.', 'wp-ai-chat' );
			if ( $provider_name ) {
				$error_msg = sprintf(
					/* translators: %s: AI provider name (e.g. OpenAI). */
					__( 'Invalid API credentials for %s. Please check your API key in Settings > AI Credentials.', 'wp-ai-chat' ),
					$provider_name
				);
			}
			return new WP_Error( 'invalid_credentials', $error_msg );
		}

		return new WP_Error(
			$code ? $code : 'api_error',
			sprintf( __( 'API error: %s', 'wp-ai-chat' ), $message )
		);
	}

	private function extract_text_content( Message $message ): string {
		$text_parts = array();
		foreach ( $message->getParts() as $part ) {
			if ( $part->getType()->isText() ) {
				$text = $part->getText();
				if ( $text ) {
					$text_parts[] = $text;
				}
			}
		}
		return implode( ' ', $text_parts );
	}

	private function has_ability_calls( Message $message ): bool {
		foreach ( $message->getParts() as $part ) {
			if ( $part->getType()->isFunctionCall() ) {
				$function_call = $part->getFunctionCall();
				if ( $function_call instanceof FunctionCall && $this->is_ability_call( $function_call ) ) {
					return true;
				}
			}
		}
		return false;
	}

	private function is_ability_call( FunctionCall $call ): bool {
		$name = $call->getName();
		return $name !== null && str_starts_with( $name, 'wpab__' );
	}

	private function execute_ability( FunctionCall $call ): FunctionResponse {
		$function_name = $call->getName() ?? 'unknown';
		$function_id   = $call->getId() ?? 'unknown';
		$ability_name  = $this->function_name_to_ability_name( $function_name );

		if ( ! $ability_name ) {
			return new FunctionResponse( $function_id, $function_name, array( 'error' => 'Not an ability function call', 'code' => 'invalid_ability_call' ) );
		}

		if ( ! function_exists( 'wp_get_ability' ) ) {
			return new FunctionResponse( $function_id, $function_name, array( 'error' => 'Abilities API not available', 'code' => 'abilities_api_not_available' ) );
		}

		$ability = wp_get_ability( $ability_name );
		if ( ! $ability instanceof \WP_Ability ) {
			return new FunctionResponse( $function_id, $function_name, array( 'error' => sprintf( 'Ability "%s" not found', $ability_name ), 'code' => 'ability_not_found' ) );
		}

		$args   = $call->getArgs();
		$input  = is_array( $args ) ? $args : array();
		$result = $ability->execute( $input );

		if ( is_wp_error( $result ) ) {
			return new FunctionResponse( $function_id, $function_name, array(
				'error' => $result->get_error_message(),
				'code'  => $result->get_error_code(),
				'data'  => $result->get_error_data(),
			) );
		}

		return new FunctionResponse( $function_id, $function_name, $result );
	}

	private function function_name_to_ability_name( ?string $function_name ): ?string {
		if ( ! $function_name || ! str_starts_with( $function_name, 'wpab__' ) ) {
			return null;
		}
		$without_prefix = substr( $function_name, strlen( 'wpab__' ) );
		return str_replace( '__', '/', $without_prefix );
	}

	private function has_api_key(): bool {
		$credentials = get_option( 'wp_ai_client_provider_credentials', array() );
		if ( ! is_array( $credentials ) ) {
			return false;
		}
		foreach ( $credentials as $api_key ) {
			if ( ! empty( $api_key ) && is_string( $api_key ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Get current conversation state metadata for the current user.
	 *
	 * @return array{prompt_count: int, char_count: int, max_prompts: int, max_chars: int}
	 */
	public function get_conversation_state_metadata(): array {
		$user_id = get_current_user_id();
		$state   = $this->get_conversation_state( $user_id );
		return array(
			'prompt_count' => $state['prompt_count'],
			'char_count'   => $state['char_count'],
			'max_prompts'  => self::MAX_PROMPTS,
			'max_chars'    => self::MAX_CHARS,
		);
	}

	/**
	 * Reset conversation state for the current user.
	 *
	 * @return array{prompt_count: int, char_count: int, max_prompts: int, max_chars: int}
	 */
	public function reset_conversation_state(): array {
		$user_id = get_current_user_id();
		$this->clear_conversation_state( $user_id );
		return array(
			'prompt_count' => 0,
			'char_count'   => 0,
			'max_prompts'  => self::MAX_PROMPTS,
			'max_chars'    => self::MAX_CHARS,
		);
	}

	private function get_conversation_state( int $user_id ): array {
		$state = get_user_meta( $user_id, self::META_KEY, true );
		if ( ! is_array( $state ) ) {
			return array( 'prompt_count' => 0, 'char_count' => 0, 'history' => array() );
		}
		return array(
			'prompt_count' => isset( $state['prompt_count'] ) ? (int) $state['prompt_count'] : 0,
			'char_count'   => isset( $state['char_count'] ) ? (int) $state['char_count'] : 0,
			'history'      => isset( $state['history'] ) && is_array( $state['history'] ) ? $state['history'] : array(),
		);
	}

	private function save_conversation_state( int $user_id, array $state ): void {
		update_user_meta( $user_id, self::META_KEY, $state );
	}

	private function clear_conversation_state( int $user_id ): void {
		delete_user_meta( $user_id, self::META_KEY );
	}

	/**
	 * Convert client history [ { role, content }, ... ] to Message objects.
	 */
	private function history_array_to_messages( array $history ): array {
		$messages = array();
		foreach ( $history as $h ) {
			$role    = isset( $h['role'] ) && in_array( $h['role'], array( 'user', 'assistant' ), true ) ? $h['role'] : 'user';
			$content = isset( $h['content'] ) && is_string( $h['content'] ) ? $h['content'] : '';
			if ( $role === 'assistant' ) {
				$messages[] = new ModelMessage( array( new MessagePart( $content ) ) );
			} else {
				$messages[] = new UserMessage( array( new MessagePart( $content ) ) );
			}
		}
		return $messages;
	}

	private function load_history_from_state( array $history_array ): array {
		$messages = array();
		foreach ( $history_array as $message_data ) {
			if ( ! is_array( $message_data ) ) {
				continue;
			}
			try {
				$messages[] = Message::fromArray( $message_data );
			} catch ( \Exception $e ) {
				continue;
			}
		}
		return $messages;
	}

	private function append_to_history( array $history_array, UserMessage $user_message, array $result ): array {
		$text_parts = array_filter( $user_message->getParts(), function ( MessagePart $part ) {
			return ! $part->getType()->isFile();
		} );
		$text_parts = array_values( $text_parts );
		if ( empty( $text_parts ) ) {
			$text_parts = array( new MessagePart( __( '[User attached image(s)]', 'wp-ai-chat' ) ) );
		}
		$user_message_for_history = new UserMessage( $text_parts );
		$history_array[] = $user_message_for_history->toArray();

		$response_text = $result['response'] ?? '';
		if ( '' !== $response_text ) {
			$model_message       = new ModelMessage( array( new MessagePart( $response_text ) ) );
			$history_array[]     = $model_message->toArray();
		}
		return $history_array;
	}
}
