<?php
/**
 * Plugin Name: WP AI Chat
 * Description: Reusable chat UI with generic AI handler. Requires wp-ai-client (via Composer).
 * Version: 1.0.0
 * Author: Everorange
 * License: GPL-2.0-or-later
 * Text Domain: wp-ai-chat
 *
 * @package WP_AI_Chat
 */

defined( 'ABSPATH' ) || exit;

define( 'WP_AI_CHAT_VERSION', '1.0.0' );
define( 'WP_AI_CHAT_PLUGIN_FILE', __FILE__ );
define( 'WP_AI_CHAT_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );

// Load Composer autoloader.
$autoloader = WP_AI_CHAT_PLUGIN_DIR . 'vendor/autoload.php';
if ( file_exists( $autoloader ) ) {
	require_once $autoloader;
}

/**
 * Bootstrap: load only when wp-ai-client is available.
 */
add_action( 'plugins_loaded', 'wp_ai_chat_init', 20 );

/**
 * Initialize the plugin.
 */
function wp_ai_chat_init(): void {
	if ( ! class_exists( 'WordPress\AI_Client\AI_Client' ) ) {
		add_action( 'admin_notices', 'wp_ai_chat_missing_client_notice' );
		return;
	}

	// Init wp-ai-client at priority 20 so provider registration runs first; then pass credentials + transporter.
	add_action( 'init', 'wp_ai_chat_init_ai_client', 20 );
	// Late pass so providers that register after 20 (e.g. some OpenAI plugin hooks) also get credentials.
	add_action( 'init', 'wp_ai_chat_pass_credentials_to_registry', 999 );

	require_once WP_AI_CHAT_PLUGIN_DIR . 'includes/class-wp-ai-chat-handler.php';
	require_once WP_AI_CHAT_PLUGIN_DIR . 'includes/class-wp-ai-chat.php';
	require_once WP_AI_CHAT_PLUGIN_DIR . 'includes/class-wp-ai-chat-runner.php';

	WP_AI_Chat::instance();
}

/**
 * Initialize wp-ai-client and ensure credentials + HTTP transporter are applied to the registry.
 * Runs at init priority 20 (after provider registration) so model resolution works.
 */
function wp_ai_chat_init_ai_client(): void {
	if ( ! class_exists( 'WordPress\AI_Client\AI_Client' ) ) {
		return;
	}

	\WordPress\AI_Client\AI_Client::init();
	wp_ai_chat_pass_credentials_to_registry();
}

/**
 * Pass stored credentials and HTTP transporter to the registry. Called at init 20 and 999.
 *
 * Also recovers credentials that the AI Experiments 0.5.0 migration moved from
 * wp_ai_client_provider_credentials into connectors_ai_* options (and then deleted
 * the original). If the main option is empty but connectors options exist, we copy
 * them back so wp-ai-client can find them.
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
 * Admin notice when wp-ai-client is not available.
 */
function wp_ai_chat_missing_client_notice(): void {
	?>
	<div class="notice notice-warning">
		<p><?php esc_html_e( 'WP AI Chat requires wp-ai-client. Run "composer install" in the plugin directory.', 'wp-ai-chat' ); ?></p>
	</div>
	<?php
}
