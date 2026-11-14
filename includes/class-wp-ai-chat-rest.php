<?php
/**
 * REST API routes for the chat UI.
 *
 * @package WP_AI_Chat
 */

defined( 'ABSPATH' ) || exit;

/**
 * Class WP_AI_Chat_REST.
 *
 * One route per job, all under wp-ai-chat/v1:
 *
 *   POST   /messages                Send a message (optionally with Media Library images), get the reply.
 *   GET    /progress/{id}           Live progress for a message still being answered.
 *   POST   /confirmations/{token}   Confirm, revise or cancel a held ability call.
 *   GET    /conversation            Conversation counters and limits.
 *   DELETE /conversation            Clear the conversation.
 *   GET    /abilities               Registered ability names.
 *   GET    /models                  Available models and the current choices.
 *   POST   /models/choice           Save this user's model ('' = site default).
 */
class WP_AI_Chat_REST {

	const NAMESPACE = 'wp-ai-chat/v1';

	/** Capability needed for every route. */
	const CAPABILITY = 'manage_options';

	/**
	 * Hook route registration.
	 */
	public static function init(): void {
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
	}

	/**
	 * Register all routes.
	 */
	public static function register_routes(): void {
		$key_arg = array(
			'type'              => 'string',
			'required'          => true,
			'sanitize_callback' => 'sanitize_key',
		);

		self::route( '/messages', 'POST', 'send_message', array(
			'prompt'         => array(
				'type'              => 'string',
				'required'          => true,
				'sanitize_callback' => 'sanitize_textarea_field',
				'validate_callback' => array( __CLASS__, 'not_blank' ),
			),
			'progress_id'    => array(
				'type'              => 'string',
				'default'           => '',
				'sanitize_callback' => 'sanitize_key',
			),
			'attachment_ids' => array(
				'type'     => 'array',
				'items'    => array( 'type' => 'integer' ),
				'default'  => array(),
				'maxItems' => WP_AI_Chat_Handler::MAX_IMAGES,
			),
		) );
		self::route( '/progress/(?P<id>[a-z0-9_-]+)', 'GET', 'get_progress', array( 'id' => $key_arg ) );
		self::route( '/confirmations/(?P<token>[a-z0-9_-]+)', 'POST', 'resolve_confirmation', array(
			'token'    => $key_arg,
			'decision' => array(
				'type'     => 'string',
				'enum'     => array( 'confirm', 'revision', 'cancel' ),
				'required' => true,
			),
		) );
		self::route( '/conversation', 'GET', 'get_conversation' );
		self::route( '/conversation', 'DELETE', 'reset_conversation' );
		self::route( '/abilities', 'GET', 'get_abilities' );
		self::route( '/models', 'GET', 'get_models' );
		self::route( '/models/choice', 'POST', 'set_model', array(
			'model' => array(
				'type'              => 'string',
				'default'           => '',
				'sanitize_callback' => 'sanitize_text_field',
			),
		) );
	}

	/**
	 * Register one route with the shared permission check.
	 *
	 * @param string $path     Route path.
	 * @param string $method   HTTP method.
	 * @param string $callback Static method name on this class.
	 * @param array  $args     Route arguments.
	 */
	private static function route( string $path, string $method, string $callback, array $args = array() ): void {
		register_rest_route(
			self::NAMESPACE,
			$path,
			array(
				'methods'             => $method,
				'callback'            => array( __CLASS__, $callback ),
				'permission_callback' => array( __CLASS__, 'can_chat' ),
				'args'                => $args,
			)
		);
	}

	/**
	 * Who may use the chat.
	 *
	 * @return bool
	 */
	public static function can_chat(): bool {
		return current_user_can( self::CAPABILITY );
	}

	/**
	 * Validate that a string argument isn't empty after trimming.
	 *
	 * @param mixed $value Argument value.
	 * @return true|WP_Error
	 */
	public static function not_blank( $value ) {
		return is_string( $value ) && '' !== trim( $value )
			? true
			: new WP_Error( 'rest_invalid_param', __( 'Please enter a message.', 'wp-ai-chat' ), array( 'status' => 400 ) );
	}

	/**
	 * POST /messages: run the prompt through the model, using server-side history.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public static function send_message( WP_REST_Request $request ) {
		$result = ( new WP_AI_Chat_Handler() )->process_prompt( $request['prompt'], $request['attachment_ids'], null, $request['progress_id'] );

		// Error data keeps the actions taken before the failure, so the UI can show them.
		return is_wp_error( $result ) ? self::with_status( $result, 500 ) : $result;
	}

	/**
	 * GET /progress/{id}.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array
	 */
	public static function get_progress( WP_REST_Request $request ): array {
		return array( 'progress' => WP_AI_Chat_Progress::read( get_current_user_id(), $request['id'] ) );
	}

	/**
	 * POST /confirmations/{token}.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public static function resolve_confirmation( WP_REST_Request $request ) {
		$outcome = ( new WP_AI_Chat_Handler() )->resolve_confirmation( $request['token'], $request['decision'] );

		return is_wp_error( $outcome ) ? self::with_status( $outcome, 400 ) : $outcome;
	}

	/**
	 * GET /conversation.
	 *
	 * @return array
	 */
	public static function get_conversation(): array {
		return array( 'state' => ( new WP_AI_Chat_Handler() )->get_conversation_state_metadata() );
	}

	/**
	 * DELETE /conversation.
	 *
	 * @return array
	 */
	public static function reset_conversation(): array {
		return array( 'state' => ( new WP_AI_Chat_Handler() )->reset_conversation_state() );
	}

	/**
	 * GET /abilities.
	 *
	 * @return array
	 */
	public static function get_abilities(): array {
		return array( 'abilities' => ( new WP_AI_Chat_Handler() )->get_registered_abilities() );
	}

	/**
	 * GET /models.
	 *
	 * @return array
	 */
	public static function get_models(): array {
		return array(
			'groups'       => WP_AI_Chat_Models::available(),
			'user_choice'  => WP_AI_Chat_Models::user_choice( get_current_user_id() ),
			'site_default' => (string) get_option( WP_AI_Chat_Models::OPTION_DEFAULT, '' ),
		);
	}

	/**
	 * POST /models/choice.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public static function set_model( WP_REST_Request $request ) {
		$choice = $request['model'];

		if ( ! WP_AI_Chat_Models::set_user_choice( get_current_user_id(), $choice ) ) {
			return new WP_Error( 'wp_ai_chat_model_unavailable', __( 'That model is not available.', 'wp-ai-chat' ), array( 'status' => 400 ) );
		}

		return array( 'model' => $choice );
	}

	/**
	 * Copy a WP_Error with an HTTP status added.
	 *
	 * @param WP_Error $error  Error.
	 * @param int      $status HTTP status.
	 * @return WP_Error
	 */
	private static function with_status( WP_Error $error, int $status ): WP_Error {
		$data = $error->get_error_data();

		return new WP_Error(
			$error->get_error_code(),
			$error->get_error_message(),
			array( 'status' => $status ) + ( is_array( $data ) ? $data : array() )
		);
	}
}
