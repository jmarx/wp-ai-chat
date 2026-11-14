<?php
/**
 * Guard against the model repeating the same ability call within one turn.
 *
 * @package WP_AI_Chat
 */

defined( 'ABSPATH' ) || exit;

/**
 * Class WP_AI_Chat_Call_Guard.
 *
 * Counts identical ability calls (same ability, same arguments) during one user
 * turn. The first MAX_IDENTICAL calls run; the next one is blocked (the model is
 * told to use the earlier result); any further identical call stops the turn.
 * Create a new instance per turn so counts start over.
 */
class WP_AI_Chat_Call_Guard {

	const RUN   = 'run';
	const BLOCK = 'block';
	const STOP  = 'stop';

	/** Identical calls allowed per turn before blocking. */
	const MAX_IDENTICAL = 2;

	/**
	 * Call fingerprint => number of times seen this turn.
	 *
	 * @var array<string, int>
	 */
	private $counts = array();

	/**
	 * Record a call and decide whether it may run.
	 *
	 * @param string               $ability_name Ability name.
	 * @param array<string, mixed> $args         Call arguments.
	 * @return string One of RUN, BLOCK, STOP.
	 */
	public function check( string $ability_name, array $args ): string {
		$key                  = self::fingerprint( $ability_name, $args );
		$this->counts[ $key ] = ( $this->counts[ $key ] ?? 0 ) + 1;
		$count                = $this->counts[ $key ];

		if ( $count <= self::MAX_IDENTICAL ) {
			return self::RUN;
		}

		if ( self::MAX_IDENTICAL + 1 === $count ) {
			return self::BLOCK;
		}

		return self::STOP;
	}

	/**
	 * Error payload sent back to the model in place of a blocked call's result.
	 *
	 * @param string $ability_name Ability name.
	 * @return array<string, string>
	 */
	public static function blocked_result( string $ability_name ): array {
		return array(
			'error' => sprintf(
				'Blocked: you already called %1$s with these exact arguments %2$d times in this turn. Use the earlier result, or ask the user what to do. Do not call it again with the same arguments.',
				$ability_name,
				self::MAX_IDENTICAL
			),
			'code'  => 'repeated_call_blocked',
		);
	}

	/**
	 * Stable key for an ability call: name plus arguments, with object keys sorted
	 * so argument order does not matter. List order is kept, since it can matter.
	 *
	 * @param string               $ability_name Ability name.
	 * @param array<string, mixed> $args         Call arguments.
	 * @return string
	 */
	public static function fingerprint( string $ability_name, array $args ): string {
		return $ability_name . '|' . md5( (string) json_encode( self::normalize( $args ) ) );
	}

	/**
	 * Recursively sort associative array keys.
	 *
	 * @param array<mixed> $value Value to normalize.
	 * @return array<mixed>
	 */
	private static function normalize( array $value ): array {
		foreach ( $value as $key => $item ) {
			if ( is_array( $item ) ) {
				$value[ $key ] = self::normalize( $item );
			}
		}

		$is_list = array() === $value || array_keys( $value ) === range( 0, count( $value ) - 1 );
		if ( ! $is_list ) {
			ksort( $value );
		}

		return $value;
	}
}
