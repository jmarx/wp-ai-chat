/**
 * WP AI Chat admin UI: server-side state, counter, reset, and live debug stream.
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

		const progressId = createProgressId();

		addMessage( prompt, 'user' );
		const $progressPanel = showLiveProgress( progressId );
		$prompt.val( '' );
		$submit.prop( 'disabled', true );

		const pollTimer = window.setInterval( function () {
			pollProgress( progressId );
		}, 500 );

		$.ajax( {
			url: window.wpAiChat.ajaxUrl,
			type: 'POST',
			data: {
				action: 'wp_ai_chat_send',
				nonce: window.wpAiChat.nonce,
				prompt: prompt,
				progress_id: progressId,
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
					const errorData = response.data || {};
					let errorMessage = 'Error: ' + ( errorData.message ? errorData.message : 'Unknown error' );
					if ( errorData.iteration ) {
						errorMessage += ' (stopped after iteration ' + errorData.iteration + ')';
					}
					addMessage( errorMessage, 'error', errorData.actions );
				}
			},
			error: function ( xhr ) {
				let msg = 'Request failed.';
				let actions = null;
				if ( xhr.responseJSON && xhr.responseJSON.data ) {
					if ( xhr.responseJSON.data.message ) {
						msg = xhr.responseJSON.data.message;
					}
					if ( xhr.responseJSON.data.actions ) {
						actions = xhr.responseJSON.data.actions;
					}
				} else if ( xhr.responseText ) {
					try {
						const parsed = JSON.parse( xhr.responseText );
						if ( parsed.data && parsed.data.message ) {
							msg = parsed.data.message;
						}
						if ( parsed.data && parsed.data.actions ) {
							actions = parsed.data.actions;
						}
					} catch ( err ) {}
				}
				addMessage( 'Error: ' + msg, 'error', actions );
			},
			complete: function () {
				window.clearInterval( pollTimer );
				pollProgress( progressId, function () {
					finalizeLiveProgress( progressId );
					$submit.prop( 'disabled', false );
				} );
			},
		} );

		return $progressPanel;
	}

	function createProgressId() {
		return 'p' + Date.now().toString( 36 ) + Math.random().toString( 36 ).slice( 2, 10 );
	}

	function getLiveProgressPanel( progressId ) {
		return $messages.find( '.wp-ai-chat-live-progress[data-progress-id="' + progressId + '"]' );
	}

	function showLiveProgress( progressId ) {
		const $panel = $( '<div>' )
			.addClass( 'wp-ai-chat-message wp-ai-chat-live-progress is-active' )
			.attr( {
				'aria-live': 'polite',
				'data-progress-id': progressId,
				'data-rendered-count': '0',
			} );
		$panel.append(
			$( '<div>' )
				.addClass( 'wp-ai-chat-live-progress-title' )
				.text( 'Debug log — working…' )
		);
		$panel.append( $( '<ul>' ).addClass( 'wp-ai-chat-live-progress-list' ) );
		$messages.append( $panel );
		$messages.scrollTop( $messages[0].scrollHeight );
		return $panel;
	}

	function finalizeLiveProgress( progressId ) {
		const $panel = getLiveProgressPanel( progressId );
		if ( ! $panel.length ) {
			return;
		}

		$panel.removeClass( 'is-active' ).addClass( 'is-finished' );

		const $title = $panel.find( '.wp-ai-chat-live-progress-title' );
		if ( $title.text().indexOf( 'Stopped' ) === -1 && $title.text().indexOf( 'Finished' ) === -1 ) {
			$title.text( 'Debug log — finished' );
		}

		if ( $panel[0] && typeof $panel[0].scrollIntoView === 'function' ) {
			$panel[0].scrollIntoView( { behavior: 'smooth', block: 'nearest' } );
		}
	}

	function pollProgress( progressId, onComplete ) {
		if ( ! progressId ) {
			if ( typeof onComplete === 'function' ) {
				onComplete();
			}
			return;
		}

		$.ajax( {
			url: window.wpAiChat.ajaxUrl,
			type: 'POST',
			data: {
				action: 'wp_ai_chat_send',
				nonce: window.wpAiChat.nonce,
				get_progress: 'true',
				progress_id: progressId,
			},
			success: function ( response ) {
				if ( response.success && response.data && response.data.progress ) {
					renderLiveProgress( progressId, response.data.progress );
				}
			},
			complete: function () {
				if ( typeof onComplete === 'function' ) {
					onComplete();
				}
			},
		} );
	}

	function renderLiveProgress( progressId, progress ) {
		const $panel = getLiveProgressPanel( progressId );
		if ( ! $panel.length || ! progress || ! Array.isArray( progress.entries ) ) {
			return;
		}

		const $list = $panel.find( '.wp-ai-chat-live-progress-list' );
		let renderedProgressCount = parseInt( $panel.attr( 'data-rendered-count' ), 10 ) || 0;
		const entries = progress.entries;

		for ( let i = renderedProgressCount; i < entries.length; i++ ) {
			const entry = entries[ i ];
			const $item = $( '<li>' ).addClass( 'wp-ai-chat-live-progress-item' );
			$item.addClass( 'wp-ai-chat-live-progress-item--' + ( entry.type || 'log' ) );

			const $header = $( '<div>' ).addClass( 'wp-ai-chat-live-progress-item-header' );

			if ( entry.ability ) {
				$header.append( $( '<span>' ).addClass( 'wp-ai-chat-live-progress-ability' ).text( entry.ability ) );
			}

			$header.append( $( '<span>' ).addClass( 'wp-ai-chat-live-progress-message' ).text( entry.message || '' ) );
			$item.append( $header );

			if ( 'ability_start' === entry.type ) {
				appendProgressPayload( $item, 'args', entry.args || {} );
			}

			if ( 'ability_done' === entry.type ) {
				appendProgressPayload( $item, 'result', entry.details || {} );
			}

			if ( false === entry.success ) {
				$item.addClass( 'is-error' );
			} else if ( true === entry.success ) {
				$item.addClass( 'is-success' );
			}

			$list.append( $item );
		}

		renderedProgressCount = entries.length;
		$panel.attr( 'data-rendered-count', String( renderedProgressCount ) );

		const $title = $panel.find( '.wp-ai-chat-live-progress-title' );

		if ( progress.iteration && 'running' === progress.status ) {
			$title.text(
				'Debug log — iteration ' + progress.iteration + ' of ' + ( progress.max_iterations || 15 )
			);
		}

		if ( progress.status && 'running' !== progress.status ) {
			$title.text(
				'error' === progress.status ? 'Debug log — stopped with error' : 'Debug log — finished'
			);
			$panel.removeClass( 'is-active' ).addClass( 'is-finished' );
		}

		$messages.scrollTop( $messages[0].scrollHeight );
	}

	function appendProgressPayload( $item, label, payload ) {
		const payloadObject = payload && 'object' === typeof payload ? payload : {};
		const payloadText = JSON.stringify( payloadObject, null, 2 );

		$item.append(
			$( '<div>' )
				.addClass( 'wp-ai-chat-live-progress-payload-wrap' )
				.append( $( '<span>' ).addClass( 'wp-ai-chat-live-progress-payload-label' ).text( label ) )
				.append( $( '<pre>' ).addClass( 'wp-ai-chat-live-progress-payload' ).text( payloadText ) )
		);
	}

	function formatActionPayload( payload ) {
		if ( ! payload || 'object' !== typeof payload ) {
			return '';
		}

		if ( 0 === Object.keys( payload ).length ) {
			return '{}';
		}

		return JSON.stringify( payload, null, 2 );
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
					// Keep chat + progress logs visible while debugging; only clear server-side state.
					addMessage( 'Conversation reset. Server history cleared and counter reset. (Debug logs kept below.)', 'success' );
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
				const argsText = formatActionPayload( action.args || {} );
				const detailsText = formatActionPayload( result );
				let actionText = '• ' + ( action.ability || 'action' );
				if ( result.error ) {
					actionText += ' — ' + result.error;
				} else if ( result.message ) {
					actionText += ' — ' + result.message;
				}
				if ( result.edit_url ) {
					actionText += ' <a href="' + result.edit_url + '" class="wp-ai-chat-action-link" target="_blank">[Edit]</a>';
				}
				const $action = $( '<div>' ).addClass( 'wp-ai-chat-action' );
				$action.append( $( '<div>' ).html( actionText ) );
				if ( argsText ) {
					$action.append(
						$( '<pre>' ).addClass( 'wp-ai-chat-action-payload' ).text( 'args:\n' + argsText )
					);
				}
				if ( detailsText && '{}' !== detailsText ) {
					$action.append(
						$( '<pre>' ).addClass( 'wp-ai-chat-action-payload' ).text( 'result:\n' + detailsText )
					);
				}
				$actionsContainer.append( $action );
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
