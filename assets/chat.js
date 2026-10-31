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

	// "Show debug details": expands the JSON behind every progress/action line.
	// Remembered per browser; storage can be unavailable, so never depend on it.
	const DEBUG_KEY = 'wpAiChatDebug';
	let debugOn = false;
	try {
		debugOn = '1' === window.localStorage.getItem( DEBUG_KEY );
	} catch ( e ) {}

	const $debugToggle = $( '<label>' )
		.addClass( 'wp-ai-chat-debug-toggle' )
		.append( $( '<input>' ).attr( 'type', 'checkbox' ).prop( 'checked', debugOn ) )
		.append( document.createTextNode( ' Show debug details' ) );

	$debugToggle.find( 'input' ).on( 'change', function () {
		debugOn = this.checked;
		try {
			window.localStorage.setItem( DEBUG_KEY, debugOn ? '1' : '0' );
		} catch ( e ) {}
		$messages.find( 'details.wp-ai-chat-details' ).prop( 'open', debugOn );
		$messages.toggleClass( 'is-debug', debugOn );
	} );

	$messages.toggleClass( 'is-debug', debugOn );

	// Model picker: lists whatever models the configured providers offer; nothing hardcoded.
	const $modelSelect = $( '<select>' )
		.addClass( 'wp-ai-chat-model-select' )
		.attr( 'aria-label', 'Model' )
		.append( $( '<option>' ).val( '' ).text( 'Loading models…' ) )
		.prop( 'disabled', true );

	$.ajax( {
		url: window.wpAiChat.ajaxUrl,
		type: 'POST',
		data: { action: 'wp_ai_chat_send', nonce: window.wpAiChat.nonce, models: 'true' },
		success: function ( response ) {
			if ( ! response || ! response.success ) {
				return;
			}
			const d = response.data;
			const defaultLabel = d.site_default ? d.site_default.split( '::' )[1] : 'automatic';
			$modelSelect.empty().append( $( '<option>' ).val( '' ).text( 'Default model (' + defaultLabel + ')' ) );
			( d.groups || [] ).forEach( function ( group ) {
				const $group = $( '<optgroup>' ).attr( 'label', group.name );
				group.models.forEach( function ( m ) {
					$group.append( $( '<option>' ).val( group.id + '::' + m.id ).text( m.name ) );
				} );
				$modelSelect.append( $group );
			} );
			$modelSelect.val( d.user_choice || '' ).prop( 'disabled', false );
		},
	} );

	$modelSelect.on( 'change', function () {
		const choice = $modelSelect.val();
		$modelSelect.prop( 'disabled', true );
		$.ajax( {
			url: window.wpAiChat.ajaxUrl,
			type: 'POST',
			data: { action: 'wp_ai_chat_send', nonce: window.wpAiChat.nonce, set_model: 'true', model: choice },
			complete: function () {
				$modelSelect.prop( 'disabled', false );
			},
		} );
	} );

	$counterContainer.append( $counter );
	$counterContainer.append( $modelSelect );
	$counterContainer.append( $debugToggle );
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
					const $reply = addMessage( data.response, 'assistant', $progressPanel.length ? null : data.actions, data.model_info, data.token_usage );
					embedProgress( $progressPanel, $reply );
					renderConfirmations( $reply, data.confirmations );
					renderRevisionCards( $reply, data.revisions );
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
				.text( 'Working…' )
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
		setFinishedTitle( $panel, $panel.hasClass( 'is-error' ) ? 'error' : 'complete' );

		const $card = $panel.closest( '.wp-ai-chat-message' );
		if ( $card[0] && typeof $card[0].scrollIntoView === 'function' ) {
			$card[0].scrollIntoView( { behavior: 'smooth', block: 'nearest' } );
		}
	}

	/** "1 action" / "3 actions" / "No actions" / "Stopped with error". */
	function setFinishedTitle( $panel, status ) {
		const $title = $panel.find( '.wp-ai-chat-live-progress-title' );
		if ( 'error' === status ) {
			$panel.addClass( 'is-error' );
			$title.text( 'Stopped with error' );
			return;
		}
		const n = $panel.find( '.wp-ai-chat-live-progress-item--ability_done' ).length;
		$title.text( n ? pluralize( n, 'action' ) : 'No actions' );
		// Plain chat with no ability calls: nothing worth showing outside debug mode.
		$panel.toggleClass( 'is-empty', 0 === n );
	}

	/**
	 * Move the step list into the top of the reply card, so each exchange is one
	 * card: steps, then the reply, then the model/token footer.
	 */
	function embedProgress( $panel, $card ) {
		if ( ! $panel || ! $panel.length || ! $card || ! $card.length ) {
			return;
		}
		$panel.removeClass( 'wp-ai-chat-message' ).addClass( 'is-embedded' );
		$card.prepend( $panel );
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
			$list.append( buildProgressItem( entries[ i ], progress ) );
		}

		renderedProgressCount = entries.length;
		$panel.attr( 'data-rendered-count', String( renderedProgressCount ) );

		const $title = $panel.find( '.wp-ai-chat-live-progress-title' );

		if ( progress.iteration && 'running' === progress.status ) {
			$title.text( 'Working… (step ' + progress.iteration + ')' );
		}

		if ( progress.status && 'running' !== progress.status ) {
			setFinishedTitle( $panel, progress.status );
			$panel.removeClass( 'is-active' ).addClass( 'is-finished' );
		}

		$messages.scrollTop( $messages[0].scrollHeight );
	}

	/**
	 * One progress entry → one line. Any JSON lives behind a click on the line
	 * (or is shown for every line when "Show debug details" is on).
	 */
	function buildProgressItem( entry, progress ) {
		const type = entry.type || 'log';
		const label = entry.label || entry.ability || '';
		let icon = '';
		let text = entry.message || '';
		let payload = null;
		let state = 'is-muted';
		// Bookkeeping lines (start/waiting/reply-ready/end) only show in debug mode.
		let verbose = true;

		switch ( type ) {
			case 'iteration_start':
				icon = '·';
				text = 'Waiting for model (step ' + ( entry.iteration || '?' ) + ' of ' + ( progress.max_iterations || 15 ) + ')';
				break;
			case 'ability_start':
				icon = '→';
				text = label + summarizeArgs( entry.args );
				payload = { args: entry.args || {} };
				state = 'is-call';
				verbose = false;
				break;
			case 'ability_done':
				if ( entry.details && 'awaiting_confirmation' === entry.details.status ) {
					icon = '?';
					text = label + ' · waiting for your confirmation';
					payload = { result: entry.details };
					state = 'is-call';
					verbose = false;
					break;
				}
				icon = false === entry.success ? '✗' : '✓';
				text = label + ' · ' + summarizeResult( entry.details, entry.success, entry.summary );
				payload = { result: undefined === entry.details ? {} : entry.details };
				state = false === entry.success ? 'is-error' : 'is-success';
				verbose = false;
				break;
			case 'model_response':
				icon = '·';
				text = 'Reply ready';
				break;
			case 'max_iterations':
				icon = '✗';
				state = 'is-error';
				verbose = false;
				break;
			case 'request_end':
				icon = '·';
				if ( 'error' === progress.status ) {
					icon = '✗';
					state = 'is-error';
					verbose = false;
				}
				break;
			default:
				icon = '·';
		}

		const $item = $( '<li>' )
			.addClass( 'wp-ai-chat-live-progress-item wp-ai-chat-live-progress-item--' + type )
			.addClass( state )
			.toggleClass( 'is-verbose', verbose );

		$item.append( buildLine( icon, text, payload, extractEditUrl( entry.details ) ) );
		return $item;
	}

	/**
	 * A single line: icon + text (+ optional Edit link). With a payload it becomes a
	 * <details> whose summary is the line and whose body is the pretty-printed JSON.
	 */
	function buildLine( icon, text, payload, editUrl, viewUrl, viewText ) {
		const $line = $( '<span>' ).addClass( 'wp-ai-chat-line' );
		if ( icon ) {
			$line.append( $( '<span>' ).addClass( 'wp-ai-chat-line-icon' ).attr( 'aria-hidden', 'true' ).text( icon ) );
		}
		$line.append( $( '<span>' ).addClass( 'wp-ai-chat-line-text' ).text( text ) );
		if ( editUrl ) {
			$line.append(
				$( '<a>' )
					.addClass( 'wp-ai-chat-action-link' )
					.attr( { href: editUrl, target: '_blank', rel: 'noopener' } )
					.text( 'Edit' )
			);
		}
		if ( viewUrl ) {
			$line.append(
				$( '<a>' )
					.addClass( 'wp-ai-chat-action-link' )
					.attr( { href: viewUrl, target: '_blank', rel: 'noopener' } )
					.text( viewText || 'View' )
			);
		}

		if ( ! payload ) {
			return $( '<div>' ).addClass( 'wp-ai-chat-line-wrap' ).append( $line );
		}

		const $details = $( '<details>' ).addClass( 'wp-ai-chat-details' ).prop( 'open', debugOn );
		$details.append( $( '<summary>' ).append( $line ) );
		$details.append( $( '<pre>' ).addClass( 'wp-ai-chat-payload' ).text( JSON.stringify( payload, null, 2 ) ) );
		return $details;
	}

	/** " · doc: 1OYAp…W60g, post_type: post" — first few args, long values shortened. */
	function summarizeArgs( args ) {
		if ( ! args || 'object' !== typeof args ) {
			return '';
		}
		const keys = Object.keys( args );
		if ( ! keys.length ) {
			return '';
		}
		const shown = keys.slice( 0, 3 ).map( function ( key ) {
			return key + ': ' + shortValue( args[ key ] );
		} );
		if ( keys.length > 3 ) {
			shown.push( '+' + ( keys.length - 3 ) + ' more' );
		}
		return ' · ' + shown.join( ', ' );
	}

	/** Pick the few result fields a human cares about; fall back to the server summary. */
	function summarizeResult( result, success, fallback ) {
		if ( false === success ) {
			const err = result && 'object' === typeof result && result.error ? result.error : fallback;
			return truncate( String( err || 'failed' ), 140 );
		}
		if ( Array.isArray( result ) ) {
			return pluralize( result.length, 'item' );
		}
		if ( ! result || 'object' !== typeof result ) {
			return fallback || 'done';
		}

		const parts = [];
		const title = result.title || result.title_raw || result.name;
		if ( 'string' === typeof title && title ) {
			parts.push( '"' + truncate( title, 50 ) + '"' );
		}
		if ( result.post_id ) {
			parts.push( 'post ' + result.post_id );
		} else if ( result.id && 'object' !== typeof result.id ) {
			parts.push( 'id ' + result.id );
		}
		if ( 'string' === typeof result.status && result.status ) {
			parts.push( result.status );
		}
		Object.keys( result ).forEach( function ( key ) {
			if ( Array.isArray( result[ key ] ) && 'warnings' !== key && parts.length < 4 ) {
				parts.push( pluralize( result[ key ].length, key.replace( /_/g, ' ' ).replace( /s$/, '' ) ) );
			}
		} );
		[ 'total', 'count', 'replaced', 'block_count' ].forEach( function ( key ) {
			if ( 'number' === typeof result[ key ] && parts.length < 4 ) {
				parts.push( key.replace( /_/g, ' ' ) + ' ' + result[ key ] );
			}
		} );
		if ( Array.isArray( result.warnings ) && result.warnings.length ) {
			parts.push( pluralize( result.warnings.length, 'warning' ) );
		}
		if ( ! parts.length && 'string' === typeof result.message && result.message ) {
			parts.push( truncate( result.message, 100 ) );
		}

		return parts.length ? parts.slice( 0, 5 ).join( ' · ' ) : ( fallback || 'done' );
	}

	function shortValue( value ) {
		if ( null === value || undefined === value ) {
			return String( value );
		}
		if ( Array.isArray( value ) ) {
			return '[' + value.length + ']';
		}
		if ( 'object' === typeof value ) {
			return '{…}';
		}
		// Keep it on one line: post HTML etc. arrives multi-line.
		const str = String( value ).replace( /\s+/g, ' ' ).trim();
		// Long token-like values (IDs, URLs): keep both ends.
		if ( str.length > 24 && ! /\s/.test( str ) ) {
			return str.slice( 0, 6 ) + '…' + str.slice( -4 );
		}
		return /\s/.test( str ) ? '"' + truncate( str, 40 ) + '"' : truncate( str, 40 );
	}

	function truncate( str, max ) {
		return str.length > max ? str.slice( 0, max - 1 ) + '…' : str;
	}

	function pluralize( n, noun ) {
		return n + ' ' + noun + ( 1 === n ? '' : 's' );
	}

	function escapeHtml( str ) {
		return String( str )
			.replace( /&/g, '&amp;' )
			.replace( /</g, '&lt;' )
			.replace( />/g, '&gt;' )
			.replace( /"/g, '&quot;' )
			.replace( /'/g, '&#39;' );
	}

	/**
	 * Minimal, safe Markdown → HTML for model replies: paragraphs, line breaks,
	 * bullet/numbered lists, **bold**, *italic*, `code`, [links](url) and bare URLs.
	 * Everything is HTML-escaped first; only http(s) links become <a>.
	 */
	function renderMarkdown( text ) {
		const blocks = escapeHtml( text || '' ).replace( /\r\n/g, '\n' ).trim().split( /\n{2,}/ );

		return blocks.map( function ( block ) {
			const lines = block.split( '\n' );
			if ( lines.every( function ( l ) { return /^\s*[-*•]\s+/.test( l ); } ) ) {
				return '<ul>' + lines.map( function ( l ) {
					return '<li>' + renderInline( l.replace( /^\s*[-*•]\s+/, '' ) ) + '</li>';
				} ).join( '' ) + '</ul>';
			}
			if ( lines.every( function ( l ) { return /^\s*\d+[.)]\s+/.test( l ); } ) ) {
				return '<ol>' + lines.map( function ( l ) {
					return '<li>' + renderInline( l.replace( /^\s*\d+[.)]\s+/, '' ) ) + '</li>';
				} ).join( '' ) + '</ol>';
			}
			const heading = block.match( /^(#{1,4})\s+(.+)$/ );
			if ( heading && 1 === lines.length ) {
				return '<p class="wp-ai-chat-md-heading">' + renderInline( heading[2] ) + '</p>';
			}
			return '<p>' + lines.map( renderInline ).join( '<br>' ) + '</p>';
		} ).join( '' );
	}

	/** Inline Markdown on already-escaped text. */
	function renderInline( str ) {
		const links = [];
		const stash = function ( html ) {
			links.push( html );
			return '\u0000' + ( links.length - 1 ) + '\u0000';
		};
		const anchor = function ( url, label ) {
			return '<a href="' + url + '" target="_blank" rel="noopener">' + label + '</a>';
		};

		// Inline code first so its contents aren't formatted.
		str = str.replace( /`([^`]+)`/g, function ( m, code ) {
			return stash( '<code>' + code + '</code>' );
		} );
		// [label](https://…)
		str = str.replace( /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function ( m, label, url ) {
			return stash( anchor( url, label ) );
		} );
		// Bare URLs (trailing punctuation stays outside the link).
		str = str.replace( /\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, function ( url ) {
			return stash( anchor( url, url ) );
		} );

		str = str
			.replace( /\*\*([^*]+)\*\*/g, '<strong>$1</strong>' )
			.replace( /(^|[^*\w])\*([^*\s][^*]*)\*(?=[^*\w]|$)/g, '$1<em>$2</em>' );

		return str.replace( /\u0000(\d+)\u0000/g, function ( m, i ) {
			return links[ Number( i ) ];
		} );
	}

	/**
	 * Destructive ability calls are held server-side; show Confirm / Cancel for each.
	 */
	function renderConfirmations( $card, confirmations ) {
		if ( ! $card || ! $card.length || ! Array.isArray( confirmations ) || ! confirmations.length ) {
			return;
		}
		confirmations.forEach( function ( c ) {
			const isChoice = 'revision_choice' === c.mode;
			const $box = $( '<div>' ).addClass( 'wp-ai-chat-confirm' );
			const isPublish = 'publish_revision' === c.mode;
			let question = c.label + summarizeArgs( c.args );
			if ( isChoice ) {
				question = 'Change "' + ( c.target_title || 'this page' ) + '"? It\'s live.';
			} else if ( isPublish ) {
				question = 'Publish your changes to "' + c.target_title + '"? This replaces the live page.';
			}
			$box.append(
				$( '<div>' ).addClass( 'wp-ai-chat-confirm-text' )
					.append( isPublish ? buildLine( '?', question ) : buildLine( '?', question, { args: c.args || {} } ) )
			);

			const button = function ( text, primary, decision ) {
				return $( '<button>' )
					.attr( 'type', 'button' )
					.addClass( primary ? 'button button-primary' : 'button' )
					.text( text )
					.on( 'click', function () {
						resolveConfirmation( c, decision, $box, $buttons );
					} );
			};

			const $buttons = $( '<div>' ).addClass( 'wp-ai-chat-confirm-buttons' );
			if ( isChoice ) {
				$buttons.append(
					button( 'Make a revision (preview first)', true, 'revision' ),
					button( 'Change live page now', false, 'confirm' ),
					button( 'Cancel', false, 'cancel' )
				);
			} else {
				$buttons.append( button( isPublish ? 'Publish' : c.label, true, 'confirm' ), button( 'Cancel', false, 'cancel' ) );
			}
			$box.append( $buttons );

			$card.find( '.wp-ai-chat-meta' ).before( $box );
			if ( ! $card.find( '.wp-ai-chat-meta' ).length ) {
				$card.append( $box );
			}
		} );
		$messages.scrollTop( $messages[0].scrollHeight );
	}

	/**
	 * "What next" card after a revision is created or changed:
	 * preview it, publish it over the live page, or ask for more changes.
	 */
	function renderRevisionCards( $card, revisions ) {
		if ( ! $card || ! $card.length || ! Array.isArray( revisions ) || ! revisions.length ) {
			return;
		}
		revisions.forEach( function ( r ) {
			const $box = $( '<div>' ).addClass( 'wp-ai-chat-confirm wp-ai-chat-revision-card' );
			$box.append(
				$( '<div>' ).addClass( 'wp-ai-chat-confirm-text' ).append(
					buildLine( '✎', 'Your revision of "' + r.target_title + '" is ready. The live page hasn\'t changed.' )
				)
			);

			const $buttons = $( '<div>' ).addClass( 'wp-ai-chat-confirm-buttons' );
			if ( /^https?:\/\//.test( r.preview_url || '' ) ) {
				$buttons.append(
					$( '<a>' ).addClass( 'button' ).attr( { href: r.preview_url, target: '_blank', rel: 'noopener' } ).text( 'Preview' )
				);
			}
			$buttons.append(
				$( '<button>' ).attr( 'type', 'button' ).addClass( 'button button-primary' ).text( 'Publish' )
					.on( 'click', function () {
						resolveConfirmation( r, 'confirm', $box, $buttons );
					} ),
				$( '<span>' ).addClass( 'wp-ai-chat-revision-hint' ).text( 'Want changes? Just tell me what to change.' )
			);
			$box.append( $buttons );

			if ( $card.find( '.wp-ai-chat-meta' ).length ) {
				$card.find( '.wp-ai-chat-meta' ).before( $box );
			} else {
				$card.append( $box );
			}
		} );
		$messages.scrollTop( $messages[0].scrollHeight );
	}

	function resolveConfirmation( c, decision, $box, $buttons ) {
		const isPublish = 'publish_revision' === c.mode;
		$buttons.find( 'button' ).prop( 'disabled', true );
		$buttons.append( $( '<span>' ).addClass( 'wp-ai-chat-confirm-working' ).text( 'cancel' === decision ? '' : 'Working…' ) );

		// The box stays where it was (buttons replaced by what was clicked); the outcome
		// arrives as a new message at the bottom of the chat, like any other reply.
		const clicked = { confirm: isPublish ? 'Publish' : 'Confirm', revision: 'Make a revision', cancel: 'Cancel' }[ decision ] || decision;
		const finish = function ( $line, state ) {
			$buttons.replaceWith(
				$( '<div>' ).addClass( 'wp-ai-chat-confirm-clicked' ).text( 'You clicked: ' + clicked )
			);
			$box.addClass( 'is-resolved' );

			const $event = $( '<div>' )
				.addClass( 'wp-ai-chat-message wp-ai-chat-message--assistant wp-ai-chat-message--event ' + ( state || '' ) )
				.append( $line );
			$messages.append( $event );
			$messages.scrollTop( $messages[0].scrollHeight );
			return $event;
		};

		$.ajax( {
			url: window.wpAiChat.ajaxUrl,
			type: 'POST',
			data: {
				action: 'wp_ai_chat_send',
				nonce: window.wpAiChat.nonce,
				confirm_action: 'true',
				token: c.token,
				decision: decision,
			},
			success: function ( response ) {
				const data = response && response.data ? response.data : {};
				if ( ! response || ! response.success ) {
					finish( buildLine( '✗', data.message || 'Request failed.' ), 'is-error' );
					return;
				}
				if ( data.cancelled ) {
					finish( buildLine( '·', ( data.label || c.label ) + ' · cancelled, nothing changed' ), 'is-cancelled' );
					return;
				}
				const result = data.result || {};
				const ok = !! data.success;
				if ( data.revision ) {
					const rev = data.revision;
					const $event = finish(
						buildLine(
							ok ? '✓' : '✗',
							ok
								? 'Revision of "' + rev.original_title + '" updated · live page unchanged'
								: 'Revision created, but the change failed · ' + ( result.error || 'failed' ),
							{ revision: rev, result: result },
							/^https?:\/\//.test( rev.edit_url || '' ) ? rev.edit_url : null,
							/^https?:\/\//.test( rev.preview_url || '' ) ? rev.preview_url : null,
							'Preview'
						),
						ok ? 'is-success' : 'is-error'
					);
					renderRevisionCards( $event, data.revisions );
					return;
				}
				if ( isPublish && ok ) {
					finish(
						buildLine( '✓', '"' + ( result.title || c.target_title ) + '" is live with your changes', { result: result }, null,
							/^https?:\/\//.test( result.live_url || '' ) ? result.live_url : null, 'View page' ),
						'is-success'
					);
					return;
				}
				finish(
					buildLine(
						ok ? '✓' : '✗',
						( data.label || c.label ) + ' · ' + ( ok ? ( result.message || summarizeResult( result, true, 'done' ) ) : ( result.error || 'failed' ) ),
						{ result: result },
						extractEditUrl( result ),
						ok && 'string' === typeof result.live_url && /^https?:\/\//.test( result.live_url ) ? result.live_url : null
					),
					ok ? 'is-success' : 'is-error'
				);
			},
			error: function () {
				finish( buildLine( '✗', 'Request failed. Nothing was confirmed.' ), 'is-error' );
			},
		} );
	}

	function extractEditUrl( result ) {
		const url = result && 'object' === typeof result ? result.edit_url : null;
		return 'string' === typeof url && /^https?:\/\//.test( url ) ? url : null;
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
					addMessage( 'Conversation reset. Server history cleared and counter reset.', 'success' );
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

		const $content = $( '<div>' ).addClass( 'wp-ai-chat-message-content' );
		if ( 'assistant' === type ) {
			// Model replies are Markdown: render links, bold, lists. Escaped first, so safe.
			$content.addClass( 'is-rich' ).html( renderMarkdown( content ) );
		} else {
			$content.text( content );
		}
		$message.append( $content );

		if ( actions && actions.length > 0 ) {
			const $actionsContainer = $( '<div>' ).addClass( 'wp-ai-chat-actions' );
			$actionsContainer.append( $( '<p>' ).addClass( 'wp-ai-chat-actions-title' ).text( 'Actions taken' ) );
			actions.forEach( function ( action ) {
				const result = action.result;
				const failed = ! result || 'object' !== typeof result || !! result.error || false === result.success;
				const label = action.label || action.ability || 'action';
				// Built with .text()/attr, never .html(): ability output is untrusted.
				const $line = buildLine(
					failed ? '✗' : '✓',
					label + ' · ' + summarizeResult( result, ! failed, '' ),
					{ args: action.args || {}, result: undefined === result ? {} : result },
					extractEditUrl( result )
				);
				$actionsContainer.append( $( '<div>' ).addClass( 'wp-ai-chat-action' ).toggleClass( 'is-error', failed ).append( $line ) );
			} );
			$message.append( $actionsContainer );
		}

		// One quiet footer line: "OpenAI gpt-4o-mini · 10,818 tokens (10,683 in / 135 out)".
		if ( 'assistant' === type && ( modelInfo || tokenUsage ) ) {
			const meta = [];
			if ( modelInfo ) {
				meta.push( modelInfo.provider + ' ' + modelInfo.model );
			}
			if ( tokenUsage ) {
				meta.push(
					( tokenUsage.total_tokens || 0 ).toLocaleString() + ' tokens (' +
					( tokenUsage.prompt_tokens || 0 ).toLocaleString() + ' in / ' +
					( tokenUsage.completion_tokens || 0 ).toLocaleString() + ' out)'
				);
			}
			$message.append( $( '<div>' ).addClass( 'wp-ai-chat-meta' ).text( meta.join( ' · ' ) ) );
		}

		$messages.append( $message );
		$messages.scrollTop( $messages[0].scrollHeight );
		return $message;
	}

	if ( $messages.children().length === 0 ) {
		addMessage( "Hi! I'm your AI assistant. What would you like me to help you with?", 'assistant' );
	}
} )( window.jQuery );
