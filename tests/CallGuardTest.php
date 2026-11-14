<?php
/**
 * Tests for WP_AI_Chat_Call_Guard.
 *
 * @package WP_AI_Chat
 */

use PHPUnit\Framework\TestCase;

/**
 * Class CallGuardTest.
 */
class CallGuardTest extends TestCase {

	/**
	 * Two identical calls run, the third is blocked, the fourth and later stop.
	 */
	public function test_run_run_block_stop(): void {
		$guard = new WP_AI_Chat_Call_Guard();
		$args  = array( 'pattern' => 'next Saturday', 'occurrences' => 1, 'start_date' => '2026-11-16' );

		$this->assertSame( WP_AI_Chat_Call_Guard::RUN, $guard->check( 'example/calculate-dates', $args ) );
		$this->assertSame( WP_AI_Chat_Call_Guard::RUN, $guard->check( 'example/calculate-dates', $args ) );
		$this->assertSame( WP_AI_Chat_Call_Guard::BLOCK, $guard->check( 'example/calculate-dates', $args ) );
		$this->assertSame( WP_AI_Chat_Call_Guard::STOP, $guard->check( 'example/calculate-dates', $args ) );
		$this->assertSame( WP_AI_Chat_Call_Guard::STOP, $guard->check( 'example/calculate-dates', $args ) );
	}

	/**
	 * Argument key order does not make calls different.
	 */
	public function test_key_order_is_ignored(): void {
		$guard = new WP_AI_Chat_Call_Guard();

		$guard->check( 'x/ability', array( 'a' => 1, 'b' => array( 'c' => 2, 'd' => 3 ) ) );
		$guard->check( 'x/ability', array( 'b' => array( 'd' => 3, 'c' => 2 ), 'a' => 1 ) );

		$this->assertSame( WP_AI_Chat_Call_Guard::BLOCK, $guard->check( 'x/ability', array( 'a' => 1, 'b' => array( 'c' => 2, 'd' => 3 ) ) ) );
	}

	/**
	 * List order still matters (e.g. a list of event IDs in a set order).
	 */
	public function test_list_order_matters(): void {
		$this->assertNotSame(
			WP_AI_Chat_Call_Guard::fingerprint( 'x/ability', array( 'ids' => array( 1, 2 ) ) ),
			WP_AI_Chat_Call_Guard::fingerprint( 'x/ability', array( 'ids' => array( 2, 1 ) ) )
		);
	}

	/**
	 * Different arguments are counted separately.
	 */
	public function test_different_args_counted_separately(): void {
		$guard = new WP_AI_Chat_Call_Guard();

		for ( $i = 0; $i < 5; $i++ ) {
			$this->assertSame( WP_AI_Chat_Call_Guard::RUN, $guard->check( 'example/list-events', array( 'page' => $i ) ) );
		}
	}

	/**
	 * Same arguments to a different ability are counted separately.
	 */
	public function test_different_abilities_counted_separately(): void {
		$guard = new WP_AI_Chat_Call_Guard();
		$args  = array( 'search' => 'Main Street' );

		$guard->check( 'example/list-venues', $args );
		$guard->check( 'example/list-venues', $args );

		$this->assertSame( WP_AI_Chat_Call_Guard::RUN, $guard->check( 'example/search-events', $args ) );
	}

	/**
	 * A new turn (new guard) starts the counts over.
	 */
	public function test_new_turn_resets(): void {
		$args  = array();
		$first = new WP_AI_Chat_Call_Guard();
		$first->check( 'example/list-venues', $args );
		$first->check( 'example/list-venues', $args );
		$this->assertSame( WP_AI_Chat_Call_Guard::BLOCK, $first->check( 'example/list-venues', $args ) );

		$second = new WP_AI_Chat_Call_Guard();
		$this->assertSame( WP_AI_Chat_Call_Guard::RUN, $second->check( 'example/list-venues', $args ) );
	}

	/**
	 * The blocked payload is an error the chat UI and the model both recognize.
	 */
	public function test_blocked_result(): void {
		$result = WP_AI_Chat_Call_Guard::blocked_result( 'example/calculate-dates' );

		$this->assertSame( 'repeated_call_blocked', $result['code'] );
		$this->assertStringContainsString( 'example/calculate-dates', $result['error'] );
	}
}
