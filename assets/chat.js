/**
 * WP AI Chat – same behavior as GatherPress AI Assistant: server-side state, counter, reset.
 */
( function ( $ ) {
	'use strict';

	const $prompt = $( '#wp-ai-chat-input' );
	const $submit = $( '.wp-ai-chat-submit' );
	const $messages = $( '.wp-ai-chat-messages' );
	const $status = $( '.wp-ai-chat-status' );
	const $inputContainer = $( '.wp-ai-chat-input-container' );
	const $abilitiesToggle = $( '.wp-ai-chat-abilities-toggle-button' );
	const $abilitiesToggleIcon = $( '.wp-ai-chat-abilities-toggle-icon' );
	const $abilitiesPanel = $( '.wp-ai-chat-abilities-panel' );
	const $abilitiesList = $( '.wp-ai-chat-abilities-list' );
	const $abilitiesEmpty = $( '.wp-ai-chat-abilities-empty' );

	const $counterContainer = $( '<div>' ).addClass( 'wp-ai-chat-counter-container' );
	const $counter = $( '<div>' ).addClass( 'wp-ai-chat-counter' ).text( '0/10 prompts • 0/40,000 characters' );
	const $resetButton = $( '<button>' ).addClass( 'button wp-ai-chat-reset-button' ).text( 'Reset Conversation' );
	const $warning = $( '<div>' ).addClass( 'wp-ai-chat-warning' ).hide();

	$counterContainer.append( $counter );
	$counterContainer.append( $resetButton );
	$inputContainer.before( $warning );
	$inputContainer.before( $counterContainer );

	let currentState = {
		prompt_count: 0,
		char_count: 0,
		max_prompts: 10,
		max_chars: 40000,
	};

	// Load initial state on page load.
	$.ajax( {
		url: window.wpAiChat.ajaxUrl,
		type: 'POST',
		data: {
			action: 'wp_ai_chat_send',
			nonce: window.wpAiChat.nonce,
			get_state: 'true',
		},
		success: function ( response ) {
			if ( response.success && response.data.state ) {
				currentState = response.data.state;
				updateCounter();
			}
		},
	} );

	// Load abilities list for collapsible panel.
	if ( $abilitiesToggle.length ) {
		$.ajax( {
			url: window.wpAiChat.ajaxUrl,
			type: 'POST',
			data: {
				action: 'wp_ai_chat_send',
				nonce: window.wpAiChat.nonce,
				abilities: 'true',
			},
			success: function( response ) {
				if ( response.success && response.data && Array.isArray( response.data.abilities ) ) {
					renderAbilities( response.data.abilities );
				}
			},
		} );

		$abilitiesToggle.on( 'click', function() {
			const isHidden = 'true' === $abilitiesPanel.attr( 'aria-hidden' );
			if ( isHidden ) {
				$abilitiesPanel.slideDown( 120 );
				$abilitiesPanel.attr( 'aria-hidden', 'false' );
				$abilitiesToggleIcon.addClass( 'is-open' );
				$abilitiesToggle.text( wpAiChat.abilitiesToggleHide || 'Hide registered abilities' );
			} else {
				$abilitiesPanel.slideUp( 120 );
				$abilitiesPanel.attr( 'aria-hidden', 'true' );
				$abilitiesToggleIcon.removeClass( 'is-open' );
				$abilitiesToggle.text( wpAiChat.abilitiesToggleShow || 'Show registered abilities' );
			}
		} );
	}

	$resetButton.on( 'click', handleReset );

	$submit.closest( 'form' ).on( 'submit', function ( e ) {
		e.preventDefault();
		processPrompt();
	} );

	$prompt.on( 'keydown', function ( e ) {
		if ( e.key === 'Enter' && ! e.shiftKey ) {
			e.preventDefault();
			processPrompt();
		}
	} );

	function processPrompt() {
		const prompt = $prompt.val().trim();
		if ( ! prompt ) {
			return;
		}

		addMessage( prompt, 'user' );
		showTypingDots();
		$prompt.val( '' );
		$submit.prop( 'disabled', true );

		$.ajax( {
			url: window.wpAiChat.ajaxUrl,
			type: 'POST',
			data: {
				action: 'wp_ai_chat_send',
				nonce: window.wpAiChat.nonce,
				prompt: prompt,
			},
			success: function ( response ) {
				if ( response.success ) {
					const data = response.data;
					if ( data.state ) {
						currentState = data.state;
						updateCounter();
					}
					if ( data.was_reset ) {
						addMessage(
							'Conversation reset: You reached the limit (' +
								currentState.max_prompts + ' prompts or ' + currentState.max_chars.toLocaleString() + ' characters). ' +
								'Your conversation history has been cleared and the conversation has started fresh.',
							'success'
						);
					}
					addMessage( data.response, 'assistant', data.actions, data.model_info, data.token_usage );
				} else {
					addMessage( 'Error: ' + ( response.data && response.data.message ? response.data.message : 'Unknown error' ), 'error' );
				}
			},
			error: function ( xhr ) {
				let msg = 'Request failed.';
				if ( xhr.responseJSON && xhr.responseJSON.data && xhr.responseJSON.data.message ) {
					msg = xhr.responseJSON.data.message;
				} else if ( xhr.responseText ) {
					try {
						const parsed = JSON.parse( xhr.responseText );
						if ( parsed.data && parsed.data.message ) {
							msg = parsed.data.message;
						}
					} catch ( err ) {}
				}
				addMessage( 'Error: ' + msg, 'error' );
			},
			complete: function () {
				removeTypingDots();
				$submit.prop( 'disabled', false );
			},
		} );
	}

	function showTypingDots() {
		var $typing = $( '<div>' )
			.addClass( 'wp-ai-chat-message wp-ai-chat-typing-dots-wrap' )
			.attr( 'aria-hidden', 'true' )
			.html( '<span class="wp-ai-chat-typing-dot"></span><span class="wp-ai-chat-typing-dot"></span><span class="wp-ai-chat-typing-dot"></span>' );
		$messages.append( $typing );
		$messages.scrollTop( $messages[0].scrollHeight );
	}

	function removeTypingDots() {
		$messages.find( '.wp-ai-chat-typing-dots-wrap' ).remove();
	}

	function renderAbilities( abilities ) {
		if ( ! $abilitiesList.length ) {
			return;
		}
		$abilitiesList.empty();
		if ( ! abilities || ! abilities.length ) {
			if ( $abilitiesEmpty.length ) {
				$abilitiesEmpty.show();
			}
			return;
		}
		if ( $abilitiesEmpty.length ) {
			$abilitiesEmpty.hide();
		}
		abilities.forEach( function( ability ) {
			const $li = $( '<li>' ).text( ability );
			$abilitiesList.append( $li );
		} );
	}

	function updateCounter() {
		const promptText = currentState.prompt_count + '/' + currentState.max_prompts + ' prompts';
		const charText = currentState.char_count.toLocaleString() + '/' + currentState.max_chars.toLocaleString() + ' characters';
		$counter.text( promptText + ' • ' + charText );

		const promptPercent = ( currentState.prompt_count / currentState.max_prompts ) * 100;
		const charPercent = ( currentState.char_count / currentState.max_chars ) * 100;
		const isApproachingLimit = promptPercent >= 80 || charPercent >= 80;

		if ( isApproachingLimit && currentState.prompt_count > 0 ) {
			$counter.addClass( 'is-warning' );
			$warning.html(
				'<strong>Warning:</strong> You are approaching the conversation limit (' +
					currentState.max_prompts + ' prompts or ' + currentState.max_chars.toLocaleString() + ' characters). ' +
					'Consider resetting to start fresh.'
			).show();
		} else {
			$counter.removeClass( 'is-warning' );
			$warning.hide();
		}
	}

	function handleReset( e ) {
		e.preventDefault();
		$resetButton.prop( 'disabled', true );

		$.ajax( {
			url: window.wpAiChat.ajaxUrl,
			type: 'POST',
			data: {
				action: 'wp_ai_chat_send',
				nonce: window.wpAiChat.nonce,
				reset: 'true',
			},
			success: function ( response ) {
				if ( response.success && response.data.state ) {
					currentState = response.data.state;
					updateCounter();
					$messages.empty();
					addMessage( 'Conversation reset. Your conversation history has been cleared and the counter has been reset.', 'success' );
					addMessage( "Hi! I'm your AI assistant. What would you like me to help you with?", 'assistant' );
				}
			},
			error: function () {
				addMessage( 'Error: Failed to reset conversation', 'error' );
			},
			complete: function () {
				$resetButton.prop( 'disabled', false );
			},
		} );
	}

	function addMessage( content, type, actions, modelInfo, tokenUsage ) {
		type = type || 'assistant';
		const $message = $( '<div>' ).addClass( 'wp-ai-chat-message wp-ai-chat-message--' + type );

		if ( modelInfo && type === 'assistant' ) {
			const $modelInfo = $( '<div>' ).addClass( 'wp-ai-chat-model-info' ).text( 'Using ' + modelInfo.provider + ' ' + modelInfo.model );
			$message.append( $modelInfo );
		}
		if ( tokenUsage && type === 'assistant' ) {
			let costText = '';
			if ( tokenUsage.estimated_cost != null ) {
				costText = ' (~$' + Number( tokenUsage.estimated_cost ).toFixed( 4 ) + ')';
			}
			const $tokenInfo = $( '<div>' ).addClass( 'wp-ai-chat-token-info' ).text(
				'Tokens: ' + ( tokenUsage.prompt_tokens || 0 ).toLocaleString() + ' prompt, ' +
				( tokenUsage.completion_tokens || 0 ).toLocaleString() + ' completion, ' +
				( tokenUsage.total_tokens || 0 ).toLocaleString() + ' total' + costText
			);
			$message.append( $tokenInfo );
		}

		const $content = $( '<div>' ).addClass( 'wp-ai-chat-message-content' ).text( content );
		$message.append( $content );

		if ( actions && actions.length > 0 ) {
			const $actionsContainer = $( '<div>' ).addClass( 'wp-ai-chat-actions' );
			$actionsContainer.append( '<p><strong>Actions taken:</strong></p>' );
			actions.forEach( function ( action ) {
				const result = action.result || {};
				let actionText = '• ' + ( action.ability || 'action' );
				if ( result.edit_url ) {
					actionText += ' <a href="' + result.edit_url + '" class="wp-ai-chat-action-link" target="_blank">[Edit]</a>';
				}
				$actionsContainer.append( $( '<div>' ).addClass( 'wp-ai-chat-action' ).html( actionText ) );
			} );
			$message.append( $actionsContainer );
		}

		$messages.append( $message );
		$messages.scrollTop( $messages[0].scrollHeight );
	}

	if ( $messages.children().length === 0 ) {
		addMessage( "Hi! I'm your AI assistant. What would you like me to help you with?", 'assistant' );
	}
} )( window.jQuery );
