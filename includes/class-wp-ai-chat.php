<?php
/**
 * Main controller: Tools page (chat UI), AJAX, assets.
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
		add_action( 'wp_ajax_wp_ai_chat_send', array( $this, 'ajax_send' ) );
	}

	/**
	 * Add Tools > AI Chat page.
	 */
	public function add_tools_page(): void {
		add_management_page(
			__( 'AI Chat', 'wp-ai-chat' ),
			__( 'AI Chat', 'wp-ai-chat' ),
			'manage_options',
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
		wp_enqueue_script( 'wp-ai-chat', $script_url, array( 'jquery' ), WP_AI_CHAT_VERSION, true );
		wp_localize_script(
			'wp-ai-chat',
			'wpAiChat',
			array(
				'ajaxUrl'            => admin_url( 'admin-ajax.php' ),
				'nonce'              => wp_create_nonce( 'wp_ai_chat_send' ),
				'abilitiesToggleShow' => __( 'Show registered abilities', 'wp-ai-chat' ),
				'abilitiesToggleHide' => __( 'Hide registered abilities', 'wp-ai-chat' ),
			)
		);
	}

	/**
	 * Render Tools > AI Chat page (same layout as GatherPress AI Assistant).
	 */
	public function render_tools_page(): void {
		$credentials_url = admin_url( 'options-general.php?page=wp-ai-client' );

		if ( ! $this->has_api_key() ) {
			?>
			<div class="wrap wp-ai-chat-wrap">
				<h1><?php esc_html_e( 'AI Chat', 'wp-ai-chat' ); ?></h1>
				<div class="notice notice-warning">
					<p>
						<strong><?php esc_html_e( 'API key required', 'wp-ai-chat' ); ?></strong><br>
						<?php esc_html_e( 'Please configure your AI API credentials to use the AI Chat.', 'wp-ai-chat' ); ?>
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
				<div class="wp-ai-chat-intro">
					<h2><?php esc_html_e( 'Chat with your chosen model', 'wp-ai-chat' ); ?></h2>
					<p><?php esc_html_e( 'Ask anything in plain language. Add abilities via the wp_ai_chat_abilities filter to give the assistant tools.', 'wp-ai-chat' ); ?></p>
					<div class="wp-ai-chat-examples">
						<p><strong><?php esc_html_e( 'Example prompts:', 'wp-ai-chat' ); ?></strong></p>
						<ul>
							<li><?php esc_html_e( 'Summarize the key points of…', 'wp-ai-chat' ); ?></li>
							<li><?php esc_html_e( 'Draft a short reply to…', 'wp-ai-chat' ); ?></li>
							<li><?php esc_html_e( 'Explain this in simpler terms…', 'wp-ai-chat' ); ?></li>
						</ul>
					</div>
					<div class="wp-ai-chat-abilities-toggle">
						<span class="wp-ai-chat-abilities-toggle-icon" aria-hidden="true">&#9654;</span>
						<button type="button" class="wp-ai-chat-abilities-toggle-button">
							<?php esc_html_e( 'Show registered abilities', 'wp-ai-chat' ); ?>
						</button>
					</div>
					<div class="wp-ai-chat-abilities-panel" aria-hidden="true">
						<p class="wp-ai-chat-abilities-empty">
							<?php esc_html_e( 'No abilities registered yet. Activate an abilities provider (for example, an AI experiments plugin) to see them here.', 'wp-ai-chat' ); ?>
						</p>
						<ul class="wp-ai-chat-abilities-list" aria-live="polite" aria-busy="false"></ul>
					</div>
				</div>
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
			</div>
		</div>
		<?php
	}

	/**
	 * Check if API key is configured (same as handler).
	 */
	private function has_api_key(): bool {
		$credentials = get_option( 'wp_ai_client_provider_credentials', array() );
		if ( ! is_array( $credentials ) ) {
			return false;
		}
		foreach ( $credentials as $api_key ) {
			if ( ! empty( $api_key ) && is_string( $api_key ) ) {
				return true;
			}
		}
		return false;
	}

	public function ajax_send(): void {
		check_ajax_referer( 'wp_ai_chat_send', 'nonce' );

		if ( ! current_user_can( 'manage_options' ) ) {
			wp_send_json_error( array( 'message' => __( 'Unauthorized.', 'wp-ai-chat' ) ) );
		}

		$handler = new WP_AI_Chat_Handler();

		// abilities: list registered ability names for UI.
		$abilities = isset( $_POST['abilities'] ) && 'true' === sanitize_text_field( wp_unslash( $_POST['abilities'] ) );
		if ( $abilities ) {
			wp_send_json_success(
				array(
					'abilities' => $handler->get_registered_abilities(),
				)
			);
		}

		// get_state: return server-side conversation state (prompt_count, char_count, limits).
		$get_state = isset( $_POST['get_state'] ) && 'true' === sanitize_text_field( wp_unslash( $_POST['get_state'] ) );
		if ( $get_state ) {
			wp_send_json_success( array( 'state' => $handler->get_conversation_state_metadata() ) );
		}

		// reset: clear server-side state and return fresh state.
		$reset = isset( $_POST['reset'] ) && 'true' === sanitize_text_field( wp_unslash( $_POST['reset'] ) );
		if ( $reset ) {
			wp_send_json_success( array( 'state' => $handler->reset_conversation_state() ) );
		}

		// prompt: use server-side history (pass null so handler loads/saves from user meta).
		$prompt = isset( $_POST['prompt'] ) ? sanitize_textarea_field( wp_unslash( $_POST['prompt'] ) ) : '';
		if ( '' === $prompt ) {
			wp_send_json_error( array( 'message' => __( 'Please enter a message.', 'wp-ai-chat' ) ) );
		}

		$result = $handler->process_prompt( $prompt, array(), null );

		if ( is_wp_error( $result ) ) {
			wp_send_json_error( array( 'message' => $result->get_error_message() ) );
		}

		wp_send_json_success( $result );
	}
}
