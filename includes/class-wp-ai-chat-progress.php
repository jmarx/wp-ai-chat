<?php
/**
 * Live progress tracking for in-flight AI requests (transient-backed polling).
 *
 * @package WP_AI_Chat
 */

defined( 'ABSPATH' ) || exit;

/**
 * Class WP_AI_Chat_Progress.
 */
class WP_AI_Chat_Progress {

	const TRANSIENT_TTL = 300;

	/**
	 * User ID owning this progress session.
	 *
	 * @var int
	 */
	private $user_id;

	/**
	 * Client-supplied progress session ID.
	 *
	 * @var string
	 */
	private $progress_id;

	/**
	 * Constructor.
	 *
	 * @param int    $user_id     Current user ID.
	 * @param string $progress_id Client progress session ID.
	 */
	public function __construct( int $user_id, string $progress_id ) {
		$this->user_id     = $user_id;
		$this->progress_id = $progress_id;
	}

	/**
	 * Mark a new request as running.
	 *
	 * @return void
	 */
	public function start(): void {
		$this->save(
			array(
				'status'         => 'running',
				'iteration'      => 0,
				'max_iterations' => WP_AI_Chat_Handler::MAX_ITERATIONS,
				'entries'        => array(
					$this->make_entry(
						'request_start',
						__( 'Processing your request…', 'wp-ai-chat' )
					),
				),
				'updated_at'     => time(),
			)
		);
	}

	/**
	 * Append a progress entry and persist.
	 *
	 * @param string               $type    Entry type slug.
	 * @param string               $message Human-readable message.
	 * @param array<string, mixed> $data    Optional structured data.
	 * @return void
	 */
	public function add_entry( string $type, string $message, array $data = array() ): void {
		$state = $this->get_state();

		if ( ! is_array( $state ) ) {
			$state = array(
				'status'         => 'running',
				'iteration'      => 0,
				'max_iterations' => WP_AI_Chat_Handler::MAX_ITERATIONS,
				'entries'        => array(),
				'updated_at'     => time(),
			);
		}

		$entry = $this->make_entry( $type, $message, $data );

		if ( isset( $data['iteration'] ) ) {
			$state['iteration'] = (int) $data['iteration'];
		}

		$state['entries'][] = $entry;
		$state['updated_at'] = time();
		$state['status']     = 'running';

		$this->save( $state );
	}

	/**
	 * Mark the session finished.
	 *
	 * @param string $status  Final status: complete|error.
	 * @param string $message Optional final message.
	 * @return void
	 */
	public function finish( string $status, string $message = '' ): void {
		$state = $this->get_state();

		if ( ! is_array( $state ) ) {
			$state = array(
				'iteration'      => 0,
				'max_iterations' => WP_AI_Chat_Handler::MAX_ITERATIONS,
				'entries'        => array(),
			);
		}

		$state['status']     = $status;
		$state['updated_at'] = time();

		if ( '' !== $message ) {
			$state['entries'][] = $this->make_entry( 'request_end', $message );
		}

		$this->save( $state );
	}

	/**
	 * Read progress for polling endpoint.
	 *
	 * @param int    $user_id     User ID.
	 * @param string $progress_id Progress session ID.
	 * @return array<string, mixed>
	 */
	public static function read( int $user_id, string $progress_id ): array {
		if ( $user_id <= 0 || '' === $progress_id ) {
			return array(
				'status'  => 'unknown',
				'entries' => array(),
			);
		}

		$state = get_transient( self::transient_key( $user_id, $progress_id ) );

		if ( ! is_array( $state ) ) {
			return array(
				'status'  => 'unknown',
				'entries' => array(),
			);
		}

		return $state;
	}

	/**
	 * Build transient key for a progress session.
	 *
	 * @param int    $user_id     User ID.
	 * @param string $progress_id Progress session ID.
	 * @return string
	 */
	public static function transient_key( int $user_id, string $progress_id ): string {
		return 'wp_ai_chat_progress_' . $user_id . '_' . $progress_id;
	}

	/**
	 * Read current state from transient.
	 *
	 * @return array<string, mixed>|false
	 */
	private function get_state() {
		return get_transient( self::transient_key( $this->user_id, $this->progress_id ) );
	}

	/**
	 * Persist state to transient.
	 *
	 * @param array<string, mixed> $state Progress state.
	 * @return void
	 */
	private function save( array $state ): void {
		set_transient(
			self::transient_key( $this->user_id, $this->progress_id ),
			$state,
			self::TRANSIENT_TTL
		);
	}

	/**
	 * Normalize a progress log entry.
	 *
	 * @param string               $type    Entry type slug.
	 * @param string               $message Human-readable message.
	 * @param array<string, mixed> $data    Optional structured data.
	 * @return array<string, mixed>
	 */
	private function make_entry( string $type, string $message, array $data = array() ): array {
		return array_merge(
			array(
				'type'      => $type,
				'message'   => $message,
				'timestamp' => time(),
			),
			$data
		);
	}
}
