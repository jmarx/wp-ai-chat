<?php
/**
 * Plugin Name: WP AI Chat
 * Description: Reusable chat UI with generic AI handler. Requires WordPress 7.0+ (bundled AI Client).
 * Version: 1.1.2
 * Author: Everorange
 * License: GPL-2.0-or-later
 * Text Domain: wp-ai-chat
 * Requires at least: 7.0
 * Requires PHP: 7.4
 *
 * @package WP_AI_Chat
 */

defined( 'ABSPATH' ) || exit;

define( 'WP_AI_CHAT_VERSION', '1.1.2' );
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

	// Pass credentials + HTTP transporter after provider registration; late pass for plugins that register providers after 20.
	add_action( 'init', 'wp_ai_chat_pass_credentials_to_registry', 20 );
	add_action( 'init', 'wp_ai_chat_pass_credentials_to_registry', 999 );

	require_once WP_AI_CHAT_PLUGIN_DIR . 'includes/class-wp-ai-chat-progress.php';
	require_once WP_AI_CHAT_PLUGIN_DIR . 'includes/class-wp-ai-chat-models.php';
	WP_AI_Chat_Models::init();
	require_once WP_AI_CHAT_PLUGIN_DIR . 'includes/class-wp-ai-chat-handler.php';
	require_once WP_AI_CHAT_PLUGIN_DIR . 'includes/class-wp-ai-chat.php';
	require_once WP_AI_CHAT_PLUGIN_DIR . 'includes/class-wp-ai-chat-runner.php';

	WP_AI_Chat::instance();
}

/**
 * Whether core exposes the AI client API this plugin uses.
 *
 * @return bool True if wp_ai_client_prompt() and AiClient are available.
 */
function wp_ai_chat_has_core_ai_client(): bool {
	return function_exists( 'wp_ai_client_prompt' )
		&& class_exists( '\WordPress\AiClient\AiClient' );
}

/**
 * Pass stored credentials and HTTP transporter to the registry. Called at init 20 and 999.
 *
 * Also recovers credentials that the AI Experiments 0.5.0 migration moved from
 * wp_ai_client_provider_credentials into connectors_ai_* options (and then deleted
 * the original). If the main option is empty but connectors options exist, we copy
 * them back so the registry can find them.
 */
function wp_ai_chat_pass_credentials_to_registry(): void {
	if ( ! class_exists( 'WordPress\AiClient\AiClient' ) ) {
		return;
	}

	$registry = \WordPress\AiClient\AiClient::defaultRegistry();

	if ( class_exists( 'WordPress\AiClient\Providers\Http\HttpTransporterFactory' ) ) {
		try {
			$transporter = \WordPress\AiClient\Providers\Http\HttpTransporterFactory::createTransporter();
			$registry->setHttpTransporter( $transporter );
		} catch ( \Throwable $e ) {
			unset( $e );
		}
	}

	$credentials = get_option( 'wp_ai_client_provider_credentials', array() );
	if ( ! is_array( $credentials ) ) {
		$credentials = array();
	}

	// Recover keys that AI Experiments 0.5.0 migrated to connectors_ai_* options.
	$connector_map = array(
		'openai'    => 'connectors_ai_openai_api_key',
		'google'    => 'connectors_ai_google_api_key',
		'anthropic' => 'connectors_ai_anthropic_api_key',
	);
	$recovered = false;
	foreach ( $connector_map as $provider_id => $connector_option ) {
		if ( ! empty( $credentials[ $provider_id ] ) ) {
			continue;
		}
		$key = get_option( $connector_option, '' );
		if ( is_string( $key ) && '' !== $key ) {
			$credentials[ $provider_id ] = $key;
			$recovered                   = true;
		}
	}
	if ( $recovered ) {
		update_option( 'wp_ai_client_provider_credentials', $credentials );
	}

	foreach ( $credentials as $provider_id => $api_key ) {
		if ( ! is_string( $api_key ) || '' === $api_key ) {
			continue;
		}
		if ( ! $registry->hasProvider( $provider_id ) ) {
			continue;
		}
		$registry->setProviderRequestAuthentication(
			$provider_id,
			new \WordPress\AiClient\Providers\Http\DTO\ApiKeyRequestAuthentication( $api_key )
		);
	}
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
