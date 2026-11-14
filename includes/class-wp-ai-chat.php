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
			</div>
		</div>
		<?php
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

		// models: available models (from configured providers) + this user's / the site's choice.
		if ( isset( $_POST['models'] ) && 'true' === sanitize_text_field( wp_unslash( $_POST['models'] ) ) ) {
			wp_send_json_success(
				array(
					'groups'       => WP_AI_Chat_Models::available(),
					'user_choice'  => WP_AI_Chat_Models::user_choice( get_current_user_id() ),
					'site_default' => (string) get_option( WP_AI_Chat_Models::OPTION_DEFAULT, '' ),
				)
			);
		}

		// set_model: save this user's model ('' = use the site default).
		if ( isset( $_POST['set_model'] ) && 'true' === sanitize_text_field( wp_unslash( $_POST['set_model'] ) ) ) {
			$choice = isset( $_POST['model'] ) ? sanitize_text_field( wp_unslash( $_POST['model'] ) ) : '';
			if ( ! WP_AI_Chat_Models::set_user_choice( get_current_user_id(), $choice ) ) {
				wp_send_json_error( array( 'message' => __( 'That model is not available.', 'wp-ai-chat' ) ) );
			}
			wp_send_json_success( array( 'model' => $choice ) );
		}

		// confirm_action: the user clicked Confirm/Cancel on a destructive ability call.
		$confirm_action = isset( $_POST['confirm_action'] ) && 'true' === sanitize_text_field( wp_unslash( $_POST['confirm_action'] ) );
		if ( $confirm_action ) {
			$token     = isset( $_POST['token'] ) ? sanitize_key( wp_unslash( $_POST['token'] ) ) : '';
			$decision = isset( $_POST['decision'] ) ? sanitize_key( wp_unslash( $_POST['decision'] ) ) : 'cancel';
			$outcome  = '' === $token
				? new WP_Error( 'missing_token', __( 'Missing confirmation token.', 'wp-ai-chat' ) )
				: $handler->resolve_confirmation( $token, $decision );

			if ( is_wp_error( $outcome ) ) {
				wp_send_json_error( array( 'message' => $outcome->get_error_message() ) );
			}
			wp_send_json_success( $outcome );
		}

		// get_progress: poll live ability progress for an in-flight request.
		$get_progress = isset( $_POST['get_progress'] ) && 'true' === sanitize_text_field( wp_unslash( $_POST['get_progress'] ) );
		if ( $get_progress ) {
			$progress_id = isset( $_POST['progress_id'] ) ? sanitize_key( wp_unslash( $_POST['progress_id'] ) ) : '';
			if ( '' === $progress_id ) {
				wp_send_json_error( array( 'message' => __( 'Missing progress ID.', 'wp-ai-chat' ) ) );
			}

			wp_send_json_success(
				array(
					'progress' => WP_AI_Chat_Progress::read( get_current_user_id(), $progress_id ),
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

		$progress_id = isset( $_POST['progress_id'] ) ? sanitize_key( wp_unslash( $_POST['progress_id'] ) ) : '';

		$result = $handler->process_prompt( $prompt, array(), null, $progress_id );

		if ( is_wp_error( $result ) ) {
			$error_data = $result->get_error_data();
			$payload    = array( 'message' => $result->get_error_message() );

			if ( is_array( $error_data ) ) {
				if ( ! empty( $error_data['actions'] ) && is_array( $error_data['actions'] ) ) {
					$payload['actions'] = $error_data['actions'];
				}
				if ( isset( $error_data['iteration'] ) ) {
					$payload['iteration'] = (int) $error_data['iteration'];
				}
			}

			wp_send_json_error( $payload );
		}

		wp_send_json_success( $result );
	}
}
