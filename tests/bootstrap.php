<?php
/**
 * PHPUnit bootstrap for tests that don't need WordPress.
 *
 * @package WP_AI_Chat
 */

require_once dirname( __DIR__ ) . '/vendor/autoload.php';

// Plugin files exit early unless ABSPATH is defined.
if ( ! defined( 'ABSPATH' ) ) {
	define( 'ABSPATH', __DIR__ . '/' );
}

require_once dirname( __DIR__ ) . '/includes/class-wp-ai-chat-call-guard.php';
