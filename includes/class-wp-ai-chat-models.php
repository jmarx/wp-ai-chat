<?php
/**
 * Model selection: discovered from whatever providers have keys configured,
 * never hardcoded. A site-wide default (Settings → AI Chat) plus a per-user
 * override from the chat's model dropdown.
 *
 * @package WP_AI_Chat
 */

defined( 'ABSPATH' ) || exit;

use WordPress\AiClient\AiClient;
use WordPress\AiClient\Providers\Models\DTO\ModelRequirements;
use WordPress\AiClient\Providers\Models\Enums\CapabilityEnum;

class WP_AI_Chat_Models {

	const OPTION_DEFAULT = 'wp_ai_chat_default_model';
	const USER_META      = 'wp_ai_chat_model';
	const CACHE_KEY      = 'wp_ai_chat_available_models';
	const CACHE_TTL      = HOUR_IN_SECONDS;

	public static function init(): void {
		add_action( 'admin_menu', array( __CLASS__, 'add_settings_page' ) );
		add_action( 'admin_init', array( __CLASS__, 'register_setting' ) );
	}

	/**
	 * Text-generation models from every configured provider, grouped by provider.
	 * Dated snapshots (e.g. gpt-5-2025-08-07) are left out to keep the list readable.
	 *
	 * @param bool $refresh Bypass the cache.
	 * @return array<int, array{id: string, name: string, models: array<int, array{id: string, name: string}>}>
	 */
	public static function available( bool $refresh = false ): array {
		$cached = $refresh ? false : get_transient( self::CACHE_KEY );
		if ( is_array( $cached ) ) {
			return $cached;
		}
		if ( ! class_exists( AiClient::class ) ) {
			return array();
		}

		$groups = array();
		try {
			$requirements = new ModelRequirements( array( CapabilityEnum::textGeneration() ), array() );
			foreach ( AiClient::defaultRegistry()->findModelsMetadataForSupport( $requirements ) as $provider_models ) {
				$provider = $provider_models->getProvider();
				$models   = array();
				foreach ( $provider_models->getModels() as $model ) {
					if ( preg_match( '/-\d{4}-\d{2}-\d{2}$|-\d{4}$/', $model->getId() ) ) {
						continue;
					}
					$models[] = array(
						'id'   => $model->getId(),
						'name' => $model->getName(),
					);
				}
				if ( $models ) {
					$groups[] = array(
						'id'     => $provider->getId(),
						'name'   => $provider->getName(),
						'models' => $models,
					);
				}
			}
		} catch ( \Throwable $e ) {
			return array(); // Not cached, so a transient provider error retries next time.
		}

		set_transient( self::CACHE_KEY, $groups, self::CACHE_TTL );
		return $groups;
	}

	/** "provider::model" if that model is currently available, else ''. */
	public static function validate( string $choice ): string {
		$parts = explode( '::', $choice, 2 );
		if ( 2 !== count( $parts ) ) {
			return '';
		}
		foreach ( self::available() as $group ) {
			if ( $group['id'] !== $parts[0] ) {
				continue;
			}
			foreach ( $group['models'] as $model ) {
				if ( $model['id'] === $parts[1] ) {
					return $choice;
				}
			}
		}
		return '';
	}

	/**
	 * The model to use for this user: their own pick, else the site default.
	 * Null means "let the AI client choose" from whatever is configured.
	 *
	 * @return array{0: string, 1: string}|null [ provider, model ]
	 */
	public static function resolve( int $user_id ): ?array {
		$choice = $user_id ? (string) get_user_meta( $user_id, self::USER_META, true ) : '';
		if ( '' === $choice || '' === self::validate( $choice ) ) {
			$choice = self::validate( (string) get_option( self::OPTION_DEFAULT, '' ) );
		}
		return '' === $choice ? null : explode( '::', $choice, 2 );
	}

	public static function user_choice( int $user_id ): string {
		return (string) get_user_meta( $user_id, self::USER_META, true );
	}

	/** Save (or clear, with '') a user's model. */
	public static function set_user_choice( int $user_id, string $choice ): bool {
		if ( '' === $choice ) {
			delete_user_meta( $user_id, self::USER_META );
			return true;
		}
		if ( '' === self::validate( $choice ) ) {
			return false;
		}
		update_user_meta( $user_id, self::USER_META, $choice );
		return true;
	}

	/* ---------- Settings → AI Chat ---------- */

	public static function add_settings_page(): void {
		add_options_page(
			__( 'AI Chat', 'wp-ai-chat' ),
			__( 'AI Chat', 'wp-ai-chat' ),
			'manage_options',
			'wp-ai-chat-settings',
			array( __CLASS__, 'render_settings_page' )
		);
	}

	public static function register_setting(): void {
		register_setting(
			'wp_ai_chat_settings',
			self::OPTION_DEFAULT,
			array(
				'type'              => 'string',
				'default'           => '',
				'sanitize_callback' => static function ( $value ) {
					return self::validate( sanitize_text_field( (string) $value ) );
				},
			)
		);
	}

	public static function render_settings_page(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$refresh = isset( $_GET['refresh-models'] ); // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- read-only cache refresh.
		$groups  = self::available( $refresh );
		$current = (string) get_option( self::OPTION_DEFAULT, '' );
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'AI Chat', 'wp-ai-chat' ); ?></h1>
			<form method="post" action="options.php">
				<?php settings_fields( 'wp_ai_chat_settings' ); ?>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><label for="wp-ai-chat-default-model"><?php esc_html_e( 'Default model', 'wp-ai-chat' ); ?></label></th>
						<td>
							<?php if ( ! $groups ) : ?>
								<p><?php esc_html_e( 'No models found. Add an AI provider key under Settings → Connectors.', 'wp-ai-chat' ); ?></p>
							<?php else : ?>
								<select id="wp-ai-chat-default-model" name="<?php echo esc_attr( self::OPTION_DEFAULT ); ?>">
									<option value=""><?php esc_html_e( 'Automatic (let WordPress pick)', 'wp-ai-chat' ); ?></option>
									<?php foreach ( $groups as $group ) : ?>
										<optgroup label="<?php echo esc_attr( $group['name'] ); ?>">
											<?php foreach ( $group['models'] as $model ) : ?>
												<?php $value = $group['id'] . '::' . $model['id']; ?>
												<option value="<?php echo esc_attr( $value ); ?>" <?php selected( $current, $value ); ?>><?php echo esc_html( $model['name'] ); ?></option>
											<?php endforeach; ?>
										</optgroup>
									<?php endforeach; ?>
								</select>
							<?php endif; ?>
							<p class="description">
								<?php esc_html_e( 'Used by everyone unless they pick a different model in the chat. The list comes from the providers configured in Settings → Connectors.', 'wp-ai-chat' ); ?>
								<a href="<?php echo esc_url( add_query_arg( 'refresh-models', '1' ) ); ?>"><?php esc_html_e( 'Refresh list', 'wp-ai-chat' ); ?></a>
							</p>
						</td>
					</tr>
				</table>
				<?php submit_button(); ?>
			</form>
		</div>
		<?php
	}
}
