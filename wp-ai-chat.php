<?php
/**
 * Plugin Name: WP AI Chat
 * Description: Reusable chat UI with generic AI handler. Requires WordPress 7.0+ (bundled AI Client).
 * Version: 1.4.0
 * Author: Everorange
 * License: GPL-2.0-or-later
 * Text Domain: wp-ai-chat
 * Requires at least: 7.0
 * Requires PHP: 7.4
 *
 * @package WP_AI_Chat
 */

defined( 'ABSPATH' ) || exit;

define( 'WP_AI_CHAT_VERSION', '1.4.0' );
define( 'WP_AI_CHAT_PLUGIN_FILE', __FILE__ );
define( 'WP_AI_CHAT_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );

/**
 * Bootstrap: load only when core AI Client is available.
 */
add_action( 'plugins_loaded', 'wp_ai_chat_init', 20 );

/**
 * Initialize the plugin.
 */
function wp_ai_chat_init(): void {
	if ( ! wp_ai_chat_has_core_ai_client() ) {
		add_action( 'admin_notices', 'wp_ai_chat_missing_client_notice' );
		return;
	}

	require_once WP_AI_CHAT_PLUGIN_DIR . 'includes/class-wp-ai-chat-progress.php';
	require_once WP_AI_CHAT_PLUGIN_DIR . 'includes/class-wp-ai-chat-models.php';
	WP_AI_Chat_Models::init();
	require_once WP_AI_CHAT_PLUGIN_DIR . 'includes/class-wp-ai-chat-call-guard.php';
	require_once WP_AI_CHAT_PLUGIN_DIR . 'includes/class-wp-ai-chat-handler.php';
	require_once WP_AI_CHAT_PLUGIN_DIR . 'includes/class-wp-ai-chat-rest.php';
	require_once WP_AI_CHAT_PLUGIN_DIR . 'includes/class-wp-ai-chat.php';
	require_once WP_AI_CHAT_PLUGIN_DIR . 'includes/class-wp-ai-chat-runner.php';

	WP_AI_Chat::instance();
}

/**
 * Images the user attached to the chat message being answered right now.
 *
 * Lets abilities act on an upload without relying on the model to pass the ID
 * along, e.g. to use it as a featured image. Empty outside a chat request (MCP,
 * REST, WP-CLI) and when nothing was attached.
 *
 * @return int[] Attachment IDs, first attached first.
 */
function wp_ai_chat_attached_images(): array {
	return class_exists( 'WP_AI_Chat_Handler' ) ? WP_AI_Chat_Handler::attached_images() : array();
}

/**
 * Whether core exposes the AI client API this plugin uses.
 *
 * @return bool True if wp_ai_client_prompt() and AiClient are available.
 */
function wp_ai_chat_has_core_ai_client(): bool {
	return function_exists( 'wp_ai_client_prompt' )
		&& class_exists( '\WordPress\AiClient\AiClient' )
		&& class_exists( 'WP_AI_Client_Ability_Function_Resolver' );
}

/**
 * Admin notice when the bundled AI Client is not available.
 */
function wp_ai_chat_missing_client_notice(): void {
	?>
	<div class="notice notice-warning">
		<p><?php esc_html_e( 'WP AI Chat requires WordPress 7.0 or newer with the bundled AI Client API (wp_ai_client_prompt).', 'wp-ai-chat' ); ?></p>
	</div>
	<?php
}
