<?php
/**
 * Prompt runner: delegates to bundled handler or filter override.
 *
 * @package WP_AI_Chat
 */

defined( 'ABSPATH' ) || exit;

/**
 * Class WP_AI_Chat_Runner.
 */
class WP_AI_Chat_Runner {

	/**
	 * Run a user message (and optional history) through the model.
	 *
	 * @param string $message Latest user message.
	 * @param array  $history Optional. Previous messages: [ [ 'role' => 'user'|'assistant', 'content' => '...' ], ... ].
	 * @param string $model   Optional. Model ID (passed to filters).
	 * @return array|WP_Error { response: string, ... } or error.
	 */
	public function run( string $message, array $history = array(), string $model = '' ) {
		$messages = $this->build_messages_for_client( $message, $history );

		/**
		 * Let the site provide the response. Return array with 'response' key, or WP_Error. Return null to use bundled handler.
		 *
		 * @param null|array|WP_Error $result  Precomputed result (null = use bundled handler).
		 * @param array               $messages Full messages array.
		 * @param string              $model   Requested model ID.
		 */
		$filtered = apply_filters( 'wp_ai_chat_response', null, $messages, $model );
		if ( null !== $filtered ) {
			if ( is_wp_error( $filtered ) ) {
				return $filtered;
			}
			if ( is_array( $filtered ) && isset( $filtered['response'] ) ) {
				return $filtered;
			}
		}

		$handler = new WP_AI_Chat_Handler();
		return $handler->process_prompt( $message, array(), $history );
	}

	/**
	 * Build messages array for filter (role + content).
	 *
	 * @param string $message Latest user message.
	 * @param array  $history Previous messages.
	 * @return array<int, array{role: string, content: string}>
	 */
	public function build_messages_for_client( string $message, array $history ): array {
		$out = array();
		foreach ( $history as $h ) {
			$role    = isset( $h['role'] ) && in_array( $h['role'], array( 'user', 'assistant' ), true ) ? $h['role'] : 'user';
			$content = isset( $h['content'] ) && is_string( $h['content'] ) ? $h['content'] : '';
			$out[]   = array( 'role' => $role, 'content' => $content );
		}
		$out[] = array( 'role' => 'user', 'content' => $message );
		return $out;
	}
}
