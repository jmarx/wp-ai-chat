<?php
/**
 * Main controller: Tools page (chat UI) and assets. Routes live in WP_AI_Chat_REST.
 *
 * @package WP_AI_Chat
 */

defined( 'ABSPATH' ) || exit;

/**
 * Class WP_AI_Chat.
 */
class WP_AI_Chat {

	private static $instance = null;

	public static function instance(): self {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	private function __construct() {
		add_action( 'admin_menu', array( $this, 'add_tools_page' ) );
		add_action( 'admin_enqueue_scripts', array( $this, 'enqueue_admin_assets' ) );
		WP_AI_Chat_REST::init();
	}

	/**
	 * Add Tools > AI Chat page.
	 */
	public function add_tools_page(): void {
		add_management_page(
			__( 'AI Chat', 'wp-ai-chat' ),
			__( 'AI Chat', 'wp-ai-chat' ),
			WP_AI_Chat_REST::CAPABILITY,
			'wp-ai-chat',
			array( $this, 'render_tools_page' )
		);
	}

	/**
	 * Enqueue chat assets only on Tools > AI Chat.
	 *
	 * @param string $hook_suffix Current admin page hook.
	 */
	public function enqueue_admin_assets( string $hook_suffix ): void {
		if ( 'tools_page_wp-ai-chat' !== $hook_suffix ) {
			return;
		}

		$script_url = plugins_url( 'assets/chat.js', WP_AI_CHAT_PLUGIN_FILE );
		$style_url  = plugins_url( 'assets/chat.css', WP_AI_CHAT_PLUGIN_FILE );

		wp_enqueue_style( 'wp-ai-chat', $style_url, array(), WP_AI_CHAT_VERSION );
		// wp-api-fetch handles the REST root and nonce.
		wp_enqueue_script( 'wp-ai-chat', $script_url, array( 'wp-api-fetch' ), WP_AI_CHAT_VERSION, true );
		wp_localize_script(
			'wp-ai-chat',
			'wpAiChat',
			array(
				'restPath'            => '/' . WP_AI_Chat_REST::NAMESPACE,
				'canUpload'           => current_user_can( 'upload_files' ),
				'maxImages'           => WP_AI_Chat_Handler::MAX_IMAGES,
				'abilitiesToggleShow' => __( 'Show registered abilities', 'wp-ai-chat' ),
				'abilitiesToggleHide' => __( 'Hide registered abilities', 'wp-ai-chat' ),
			)
		);
	}

	/**
	 * Render Tools > AI Chat page.
	 */
	public function render_tools_page(): void {
		$credentials_url = admin_url( 'options-connectors.php' );

		if ( ! WP_AI_Chat_Handler::ai_available() ) {
			?>
			<div class="wrap wp-ai-chat-wrap">
				<h1><?php esc_html_e( 'AI Chat', 'wp-ai-chat' ); ?></h1>
				<div class="notice notice-warning">
					<p>
						<strong><?php esc_html_e( 'API key required', 'wp-ai-chat' ); ?></strong><br>
						<?php esc_html_e( 'Add an AI provider API key in Settings > Connectors to use the AI Chat.', 'wp-ai-chat' ); ?>
					</p>
					<p>
						<a href="<?php echo esc_url( $credentials_url ); ?>" class="button button-primary">
							<?php esc_html_e( 'Configure API key', 'wp-ai-chat' ); ?>
						</a>
					</p>
				</div>
			</div>
			<?php
			return;
		}
		?>
		<div class="wrap wp-ai-chat-wrap">
			<h1><?php esc_html_e( 'AI Chat', 'wp-ai-chat' ); ?></h1>
			<div class="wp-ai-chat-container">
				<div class="wp-ai-chat" id="wp-ai-chat">
					<div class="wp-ai-chat-messages" role="log" aria-live="polite"></div>
					<form class="wp-ai-chat-form" method="post" action="">
						<div class="wp-ai-chat-input-container">
							<label for="wp-ai-chat-input" class="screen-reader-text"><?php esc_html_e( 'Your message', 'wp-ai-chat' ); ?></label>
							<textarea id="wp-ai-chat-input" class="wp-ai-chat-input" name="message" rows="3" placeholder="<?php esc_attr_e( 'What would you like me to do?', 'wp-ai-chat' ); ?>" required></textarea>
							<button type="submit" class="wp-ai-chat-submit button button-primary button-large"><?php esc_html_e( 'Send', 'wp-ai-chat' ); ?></button>
						</div>
					</form>
					<div class="wp-ai-chat-status" aria-hidden="true"></div>
				</div>
				<div class="wp-ai-chat-abilities">
					<div class="wp-ai-chat-abilities-toggle">
						<span class="wp-ai-chat-abilities-toggle-icon" aria-hidden="true">&#9654;</span>
						<button type="button" class="wp-ai-chat-abilities-toggle-button" aria-expanded="false" aria-controls="wp-ai-chat-abilities-panel">
							<?php esc_html_e( 'Show registered abilities', 'wp-ai-chat' ); ?>
						</button>
					</div>
					<div class="wp-ai-chat-abilities-panel" id="wp-ai-chat-abilities-panel" hidden>
						<p class="wp-ai-chat-abilities-empty">
							<?php esc_html_e( 'No abilities registered yet. Activate an abilities provider (for example, an AI experiments plugin) to see them here.', 'wp-ai-chat' ); ?>
						</p>
						<ul class="wp-ai-chat-abilities-list" aria-live="polite" aria-busy="false"></ul>
					</div>
				</div>
			</div>
		</div>
		<?php
	}
}
