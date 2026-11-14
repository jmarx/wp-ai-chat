/**
 * WP AI Chat admin UI: chat, live progress, confirmations, model picker, counter and reset.
 *
 * Plain JavaScript (no build step, no jQuery). Talks to the wp-ai-chat/v1 REST routes
 * through wp.apiFetch, which adds the REST root and nonce.
 */
( function () {
	'use strict';

	const settings = window.wpAiChat || {};
	const root = document.getElementById( 'wp-ai-chat' );

	// No chat on the page (e.g. the "API key required" notice is shown instead).
	if ( ! root ) {
		return;
	}

	const find = ( selector ) => document.querySelector( selector );
	const ui = {
		form: root.querySelector( '.wp-ai-chat-form' ),
		prompt: find( '#wp-ai-chat-input' ),
		submit: root.querySelector( '.wp-ai-chat-submit' ),
		messages: root.querySelector( '.wp-ai-chat-messages' ),
		inputContainer: root.querySelector( '.wp-ai-chat-input-container' ),
		abilitiesToggle: find( '.wp-ai-chat-abilities-toggle-button' ),
		abilitiesIcon: find( '.wp-ai-chat-abilities-toggle-icon' ),
		abilitiesPanel: find( '.wp-ai-chat-abilities-panel' ),
		abilitiesList: find( '.wp-ai-chat-abilities-list' ),
		abilitiesEmpty: find( '.wp-ai-chat-abilities-empty' ),
	};

	/* ------------------------------------------------------------------ *
	 * Helpers
	 * ------------------------------------------------------------------ */

	/** Call a wp-ai-chat/v1 route. Rejects with { code, message, data } on error. */
	function api( path, options ) {
		return window.wp.apiFetch( Object.assign( { path: settings.restPath + path }, options ) );
	}

	function errorMessage( error, fallback ) {
		return ( error && error.message ) || fallback || 'Request failed.';
	}

	/**
	 * Create an element. Text is always set with textContent; untrusted output never
	 * goes through innerHTML (the only exception is renderMarkdown, which escapes first).
	 */
	function el( tag, { className, text, attrs, on } = {}, children = [] ) {
		const node = document.createElement( tag );
		if ( className ) {
			node.className = className;
		}
		if ( undefined !== text ) {
			node.textContent = text;
		}
		Object.entries( attrs || {} ).forEach( ( [ name, value ] ) => node.setAttribute( name, value ) );
		Object.entries( on || {} ).forEach( ( [ event, handler ] ) => node.addEventListener( event, handler ) );
		node.append( ...children.filter( ( child ) => child || 0 === child ) );
		return node;
	}

	function button( text, primary, onClick ) {
		return el( 'button', {
			className: primary ? 'button button-primary' : 'button',
			text,
			attrs: { type: 'button' },
			on: { click: onClick },
		} );
	}

	function externalLink( url, text, className ) {
		return el( 'a', { className, text, attrs: { href: url, target: '_blank', rel: 'noopener' } } );
	}

	function option( value, text ) {
		const node = el( 'option', { text } );
		node.value = value;
		return node;
	}

	/** The URL if it's http(s), else null. Ability output is untrusted. */
	function httpUrl( url ) {
		return 'string' === typeof url && /^https?:\/\//.test( url ) ? url : null;
	}

	function extractEditUrl( result ) {
		return httpUrl( result && 'object' === typeof result ? result.edit_url : null );
	}

	function scrollToBottom() {
		ui.messages.scrollTop = ui.messages.scrollHeight;
	}

	/** Put a box above the card's model/token footer, or at the end if there is none. */
	function insertBeforeMeta( card, box ) {
		const meta = card.querySelector( '.wp-ai-chat-meta' );
		if ( meta ) {
			meta.before( box );
		} else {
			card.append( box );
		}
	}

	function truncate( str, max ) {
		return str.length > max ? str.slice( 0, max - 1 ) + '…' : str;
	}

	function pluralize( n, noun ) {
		return n + ' ' + noun + ( 1 === n ? '' : 's' );
	}

	/* ------------------------------------------------------------------ *
	 * Controls: counter, model picker, debug toggle, reset
	 * ------------------------------------------------------------------ */

	let currentState = {
		prompt_count: 0,
		char_count: 0,
		max_prompts: 10,
		max_chars: 40000,
	};

	// "Show debug details": expands the JSON behind every progress/action line.
	// Remembered per browser; storage can be unavailable, so never depend on it.
	const DEBUG_KEY = 'wpAiChatDebug';
	let debugOn = false;
	try {
		debugOn = '1' === window.localStorage.getItem( DEBUG_KEY );
	} catch ( e ) {}

	const debugCheckbox = el( 'input', { attrs: { type: 'checkbox' } } );
	debugCheckbox.checked = debugOn;
	debugCheckbox.addEventListener( 'change', () => {
		debugOn = debugCheckbox.checked;
		try {
			window.localStorage.setItem( DEBUG_KEY, debugOn ? '1' : '0' );
		} catch ( e ) {}
		ui.messages.querySelectorAll( 'details.wp-ai-chat-details' ).forEach( ( details ) => {
			details.open = debugOn;
		} );
		ui.messages.classList.toggle( 'is-debug', debugOn );
	} );
	ui.messages.classList.toggle( 'is-debug', debugOn );

	// Model picker: lists whatever models the configured providers offer; nothing hardcoded.
	const modelSelect = el( 'select', { className: 'wp-ai-chat-model-select', attrs: { 'aria-label': 'Model' } }, [
		option( '', 'Loading models…' ),
	] );
	modelSelect.disabled = true;
	modelSelect.addEventListener( 'change', async () => {
		modelSelect.disabled = true;
		try {
			await api( '/models/choice', { method: 'POST', data: { model: modelSelect.value } } );
		} catch ( error ) {
			addMessage( 'Error: ' + errorMessage( error ), 'error' );
		} finally {
			modelSelect.disabled = false;
			updateAttachButton();
		}
	} );

	const counter = el( 'div', { className: 'wp-ai-chat-counter', text: '0/10 prompts • 0/40,000 characters' } );
	const warning = el( 'div', { className: 'wp-ai-chat-warning', attrs: { hidden: '' } } );
	const resetButton = el( 'button', {
		className: 'button wp-ai-chat-reset-button',
		text: 'Reset Conversation',
		attrs: { type: 'button' },
		on: { click: resetConversation },
	} );

	ui.inputContainer.before(
		warning,
		el( 'div', { className: 'wp-ai-chat-counter-container' }, [
			counter,
			modelSelect,
			el( 'label', { className: 'wp-ai-chat-debug-toggle' }, [ debugCheckbox, ' Show debug details' ] ),
			resetButton,
		] )
	);

	/* ------------------------------------------------------------------ *
	 * Image attachments: uploaded to the Media Library, sent by ID
	 * ------------------------------------------------------------------ */

	// Models that accept images ("provider::model"), and whether the default model does.
	const imageModels = new Set();
	let defaultTakesImages = false;
	let attachments = []; // { id, name, thumb, chip }; id is null while uploading.
	let sending = false;

	const fileInput = el( 'input', {
		className: 'screen-reader-text',
		attrs: { type: 'file', accept: 'image/jpeg,image/png,image/gif,image/webp', multiple: '', tabindex: '-1' },
		on: { change: () => uploadFiles( Array.from( fileInput.files ) ) },
	} );
	const attachButton = el( 'button', {
		className: 'button button-large wp-ai-chat-attach',
		text: 'Add image',
		attrs: { type: 'button', hidden: '' },
		on: { click: () => fileInput.click() },
	} );
	const tray = el( 'div', { className: 'wp-ai-chat-attachments', attrs: { hidden: '' } } );

	ui.submit.before( attachButton, fileInput );
	ui.inputContainer.before( tray );

	// Only offer uploads when the user may upload and the chosen model can see images.
	function updateAttachButton() {
		const choice = modelSelect.value;
		const takesImages = choice ? imageModels.has( choice ) : defaultTakesImages;
		attachButton.hidden = ! settings.canUpload || ! takesImages;
		if ( attachButton.hidden ) {
			attachments.forEach( ( a ) => a.chip.remove() );
			attachments = [];
			refreshTray();
		}
	}

	function refreshTray() {
		tray.hidden = ! attachments.length;
		attachButton.disabled = attachments.length >= ( settings.maxImages || 4 );
		ui.submit.disabled = sending || attachments.some( ( a ) => ! a.id );
	}

	function uploadFiles( files ) {
		fileInput.value = '';
		const room = ( settings.maxImages || 4 ) - attachments.length;
		files.slice( 0, room ).forEach( uploadFile );
	}

	async function uploadFile( file ) {
		const item = { id: null, name: file.name, thumb: '', chip: null };
		item.chip = el( 'div', { className: 'wp-ai-chat-attachment is-uploading' }, [
			el( 'span', { className: 'wp-ai-chat-attachment-name', text: 'Uploading ' + file.name + '…' } ),
		] );
		attachments.push( item );
		tray.append( item.chip );
		refreshTray();

		const body = new window.FormData();
		body.append( 'file', file, file.name );
		try {
			const media = await window.wp.apiFetch( { path: '/wp/v2/media', method: 'POST', body } );
			const sizes = ( media.media_details && media.media_details.sizes ) || {};
			item.id = media.id;
			item.thumb = ( sizes.thumbnail || sizes.medium || {} ).source_url || media.source_url;
			item.chip.classList.remove( 'is-uploading' );
			item.chip.replaceChildren(
				el( 'img', { attrs: { src: item.thumb, alt: '' } } ),
				el( 'span', { className: 'wp-ai-chat-attachment-name', text: file.name } ),
				el( 'button', {
					className: 'wp-ai-chat-attachment-remove',
					text: '×',
					attrs: { type: 'button', 'aria-label': 'Remove ' + file.name + ' from this message' },
					on: { click: () => removeAttachment( item ) },
				} )
			);
		} catch ( error ) {
			removeAttachment( item );
			addMessage( 'Error: could not upload ' + file.name + ': ' + errorMessage( error ), 'error' );
		}
		refreshTray();
	}

	// Takes the image off this message only; it stays in the Media Library.
	function removeAttachment( item ) {
		item.chip.remove();
		attachments = attachments.filter( ( a ) => a !== item );
		refreshTray();
	}

	async function loadModels() {
		try {
			const data = await api( '/models' );
			imageModels.clear();
			( data.groups || [] ).forEach( ( group ) =>
				group.models.forEach( ( model ) => model.images && imageModels.add( group.id + '::' + model.id ) )
			);
			// With no site default the AI client picks a model itself, and can pick one that takes images.
			defaultTakesImages = data.site_default ? imageModels.has( data.site_default ) : imageModels.size > 0;
			const defaultLabel = data.site_default ? data.site_default.split( '::' )[ 1 ] : 'automatic';
			modelSelect.replaceChildren(
				option( '', 'Default model (' + defaultLabel + ')' ),
				...( data.groups || [] ).map( ( group ) =>
					el(
						'optgroup',
						{ attrs: { label: group.name } },
						group.models.map( ( model ) => option( group.id + '::' + model.id, model.name ) )
					)
				)
			);
			modelSelect.value = data.user_choice || '';
			modelSelect.disabled = false;
			updateAttachButton();
		} catch ( e ) {}
	}

	async function loadState() {
		try {
			setState( ( await api( '/conversation' ) ).state );
		} catch ( e ) {}
	}

	function setState( state ) {
		if ( ! state ) {
			return;
		}
		currentState = state;
		updateCounter();
	}

	function updateCounter() {
		const { prompt_count: prompts, char_count: chars, max_prompts: maxPrompts, max_chars: maxChars } = currentState;
		counter.textContent =
			prompts + '/' + maxPrompts + ' prompts • ' + chars.toLocaleString() + '/' + maxChars.toLocaleString() + ' characters';

		const nearLimit = prompts > 0 && ( prompts / maxPrompts >= 0.8 || chars / maxChars >= 0.8 );
		counter.classList.toggle( 'is-warning', nearLimit );
		warning.hidden = ! nearLimit;
		if ( nearLimit ) {
			warning.replaceChildren(
				el( 'strong', { text: 'Warning:' } ),
				' You are approaching the conversation limit (' + maxPrompts + ' prompts or ' +
					maxChars.toLocaleString() + ' characters). Consider resetting to start fresh.'
			);
		}
	}

	async function resetConversation() {
		resetButton.disabled = true;
		try {
			setState( ( await api( '/conversation', { method: 'DELETE' } ) ).state );
			// Keep chat + progress logs visible while debugging; only clear server-side state.
			addMessage( 'Conversation reset. Server history cleared and counter reset.', 'success' );
		} catch ( e ) {
			addMessage( 'Error: Failed to reset conversation', 'error' );
		} finally {
			resetButton.disabled = false;
		}
	}

	/* ------------------------------------------------------------------ *
	 * Abilities panel
	 * ------------------------------------------------------------------ */

	async function loadAbilities() {
		try {
			const { abilities } = await api( '/abilities' );
			renderAbilities( Array.isArray( abilities ) ? abilities : [] );
		} catch ( e ) {}
	}

	function renderAbilities( abilities ) {
		ui.abilitiesList.replaceChildren( ...abilities.map( ( name ) => el( 'li', { text: name } ) ) );
		ui.abilitiesEmpty.hidden = abilities.length > 0;
	}

	function toggleAbilities() {
		const open = ui.abilitiesPanel.hidden;
		ui.abilitiesPanel.hidden = ! open;
		ui.abilitiesToggle.setAttribute( 'aria-expanded', String( open ) );
		ui.abilitiesIcon.classList.toggle( 'is-open', open );
		ui.abilitiesToggle.textContent = open
			? settings.abilitiesToggleHide || 'Hide registered abilities'
			: settings.abilitiesToggleShow || 'Show registered abilities';
	}

	/* ------------------------------------------------------------------ *
	 * Sending a message
	 * ------------------------------------------------------------------ */

	async function sendPrompt() {
		const images = attachments.filter( ( a ) => a.id );
		// An image on its own is a message too.
		const prompt = ui.prompt.value.trim() || ( images.length ? 'See the attached image.' : '' );
		if ( ! prompt || ui.submit.disabled ) {
			return;
		}

		const progressId = createProgressId();
		const sent = addMessage( prompt, 'user' );
		if ( images.length ) {
			sent.append(
				el( 'div', { className: 'wp-ai-chat-sent-images' }, images.map( ( a ) => el( 'img', { attrs: { src: a.thumb, alt: a.name } } ) ) )
			);
		}
		const panel = showLiveProgress( progressId );
		ui.prompt.value = '';
		attachments.forEach( ( a ) => a.chip.remove() );
		attachments = [];
		sending = true;
		refreshTray();

		const pollTimer = window.setInterval( () => pollProgress( progressId ), 500 );

		try {
			const data = { prompt, progress_id: progressId, attachment_ids: images.map( ( a ) => a.id ) };
			showReply( await api( '/messages', { method: 'POST', data } ), panel );
		} catch ( error ) {
			const data = error.data || {};
			let message = 'Error: ' + errorMessage( error, 'Unknown error' );
			if ( data.iteration ) {
				message += ' (stopped after iteration ' + data.iteration + ')';
			}
			addMessage( message, 'error', data.actions );
		} finally {
			window.clearInterval( pollTimer );
			await pollProgress( progressId );
			finalizeLiveProgress( progressId );
			sending = false;
			refreshTray();
		}
	}

	function showReply( data, panel ) {
		setState( data.state );
		if ( data.was_reset ) {
			addMessage(
				'Conversation reset: You reached the limit (' + currentState.max_prompts + ' prompts or ' +
					currentState.max_chars.toLocaleString() + ' characters). ' +
					'Your conversation history has been cleared and the conversation has started fresh.',
				'success'
			);
		}
		// The actions already show as steps in the progress panel, which moves into the reply.
		const reply = addMessage( data.response, 'assistant', null, data.model_info, data.token_usage );
		embedProgress( panel, reply );
		renderConfirmations( reply, data.confirmations );
		renderRevisionCards( reply, data.revisions );
	}

	function addMessage( content, type = 'assistant', actions = null, modelInfo = null, tokenUsage = null ) {
		const body = el( 'div', { className: 'wp-ai-chat-message-content' } );
		if ( 'assistant' === type ) {
			// Model replies are Markdown: render links, bold, lists. Escaped first, so safe.
			body.classList.add( 'is-rich' );
			body.innerHTML = renderMarkdown( content );
		} else {
			body.textContent = content;
		}

		const message = el( 'div', { className: 'wp-ai-chat-message wp-ai-chat-message--' + type }, [
			body,
			buildActionsList( actions ),
			'assistant' === type ? buildMetaLine( modelInfo, tokenUsage ) : null,
		] );

		ui.messages.append( message );
		scrollToBottom();
		return message;
	}

	function buildActionsList( actions ) {
		if ( ! Array.isArray( actions ) || ! actions.length ) {
			return null;
		}
		return el( 'div', { className: 'wp-ai-chat-actions' }, [
			el( 'p', { className: 'wp-ai-chat-actions-title', text: 'Actions taken' } ),
			...actions.map( ( action ) => {
				const result = action.result;
				const failed = ! result || 'object' !== typeof result || !! result.error || false === result.success;
				const line = buildLine(
					failed ? '✗' : '✓',
					( action.label || action.ability || 'action' ) + ' · ' + summarizeResult( result, ! failed, '' ),
					{ args: action.args || {}, result: undefined === result ? {} : result },
					extractEditUrl( result )
				);
				const row = el( 'div', { className: 'wp-ai-chat-action' }, [ line ] );
				row.classList.toggle( 'is-error', failed );
				return row;
			} ),
		] );
	}

	/** One quiet footer line: "OpenAI gpt-4o-mini · 10,818 tokens (10,683 in / 135 out)". */
	function buildMetaLine( modelInfo, tokenUsage ) {
		if ( ! modelInfo && ! tokenUsage ) {
			return null;
		}
		const parts = [];
		if ( modelInfo ) {
			parts.push( modelInfo.provider + ' ' + modelInfo.model );
		}
		if ( tokenUsage ) {
			parts.push(
				( tokenUsage.total_tokens || 0 ).toLocaleString() + ' tokens (' +
					( tokenUsage.prompt_tokens || 0 ).toLocaleString() + ' in / ' +
					( tokenUsage.completion_tokens || 0 ).toLocaleString() + ' out)'
			);
		}
		return el( 'div', { className: 'wp-ai-chat-meta', text: parts.join( ' · ' ) } );
	}

	/* ------------------------------------------------------------------ *
	 * Live progress
	 * ------------------------------------------------------------------ */

	function createProgressId() {
		return 'p' + Date.now().toString( 36 ) + Math.random().toString( 36 ).slice( 2, 10 );
	}

	function getLiveProgressPanel( progressId ) {
		return ui.messages.querySelector( '.wp-ai-chat-live-progress[data-progress-id="' + progressId + '"]' );
	}

	function showLiveProgress( progressId ) {
		const panel = el(
			'div',
			{
				className: 'wp-ai-chat-message wp-ai-chat-live-progress is-active',
				attrs: { 'aria-live': 'polite', 'data-progress-id': progressId, 'data-rendered-count': '0' },
			},
			[
				el( 'div', { className: 'wp-ai-chat-live-progress-title', text: 'Working…' } ),
				el( 'ul', { className: 'wp-ai-chat-live-progress-list' } ),
			]
		);
		ui.messages.append( panel );
		scrollToBottom();
		return panel;
	}

	/** Fetch progress once; a missed poll is harmless, the next one catches up. */
	async function pollProgress( progressId ) {
		try {
			const { progress } = await api( '/progress/' + progressId );
			renderLiveProgress( progressId, progress );
		} catch ( e ) {}
	}

	function renderLiveProgress( progressId, progress ) {
		const panel = getLiveProgressPanel( progressId );
		if ( ! panel || ! progress || ! Array.isArray( progress.entries ) ) {
			return;
		}

		const list = panel.querySelector( '.wp-ai-chat-live-progress-list' );
		const rendered = parseInt( panel.dataset.renderedCount, 10 ) || 0;
		list.append( ...progress.entries.slice( rendered ).map( ( entry ) => buildProgressItem( entry, progress ) ) );
		panel.dataset.renderedCount = String( Math.max( rendered, progress.entries.length ) );

		if ( progress.iteration && 'running' === progress.status ) {
			panel.querySelector( '.wp-ai-chat-live-progress-title' ).textContent = 'Working… (step ' + progress.iteration + ')';
		}

		if ( progress.status && 'running' !== progress.status ) {
			setFinishedTitle( panel, progress.status );
			panel.classList.replace( 'is-active', 'is-finished' );
		}

		scrollToBottom();
	}

	function finalizeLiveProgress( progressId ) {
		const panel = getLiveProgressPanel( progressId );
		if ( ! panel ) {
			return;
		}

		panel.classList.remove( 'is-active' );
		panel.classList.add( 'is-finished' );
		setFinishedTitle( panel, panel.classList.contains( 'is-error' ) ? 'error' : 'complete' );

		const card = panel.closest( '.wp-ai-chat-message' );
		if ( card && 'function' === typeof card.scrollIntoView ) {
			card.scrollIntoView( { behavior: 'smooth', block: 'nearest' } );
		}
	}

	/** "1 action" / "3 actions" / "No actions" / "Stopped with error". */
	function setFinishedTitle( panel, status ) {
		const title = panel.querySelector( '.wp-ai-chat-live-progress-title' );
		if ( 'error' === status ) {
			panel.classList.add( 'is-error' );
			title.textContent = 'Stopped with error';
			return;
		}
		const n = panel.querySelectorAll( '.wp-ai-chat-live-progress-item--ability_done' ).length;
		title.textContent = n ? pluralize( n, 'action' ) : 'No actions';
		// Plain chat with no ability calls: nothing worth showing outside debug mode.
		panel.classList.toggle( 'is-empty', 0 === n );
	}

	/**
	 * Move the step list into the top of the reply card, so each exchange is one
	 * card: steps, then the reply, then the model/token footer.
	 */
	function embedProgress( panel, card ) {
		if ( ! panel || ! card ) {
			return;
		}
		panel.classList.remove( 'wp-ai-chat-message' );
		panel.classList.add( 'is-embedded' );
		card.prepend( panel );
	}

	/**
	 * One progress entry → one line. Any JSON lives behind a click on the line
	 * (or is shown for every line when "Show debug details" is on).
	 */
	function buildProgressItem( entry, progress ) {
		const type = entry.type || 'log';
		const label = entry.label || entry.ability || '';
		let icon = '·';
		let text = entry.message || '';
		let payload = null;
		let state = 'is-muted';
		// Bookkeeping lines (start/waiting/reply-ready/end) only show in debug mode.
		let verbose = true;

		switch ( type ) {
			case 'iteration_start':
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
				verbose = false;
				if ( entry.details && 'awaiting_confirmation' === entry.details.status ) {
					icon = '?';
					text = label + ' · waiting for your confirmation';
					payload = { result: entry.details };
					state = 'is-call';
					break;
				}
				icon = false === entry.success ? '✗' : '✓';
				text = label + ' · ' + summarizeResult( entry.details, entry.success, entry.summary );
				payload = { result: undefined === entry.details ? {} : entry.details };
				state = false === entry.success ? 'is-error' : 'is-success';
				break;
			case 'model_response':
				text = 'Reply ready';
				break;
			case 'max_iterations':
			case 'repeated_call_stop':
				icon = '✗';
				state = 'is-error';
				verbose = false;
				break;
			case 'request_end':
				if ( 'error' === progress.status ) {
					icon = '✗';
					state = 'is-error';
					verbose = false;
				}
				break;
		}

		const item = el( 'li', {
			className: 'wp-ai-chat-live-progress-item wp-ai-chat-live-progress-item--' + type + ' ' + state,
		}, [ buildLine( icon, text, payload, extractEditUrl( entry.details ) ) ] );
		item.classList.toggle( 'is-verbose', verbose );
		return item;
	}

	/**
	 * A single line: icon + text (+ optional Edit / View links). With a payload it becomes
	 * a <details> whose summary is the line and whose body is the pretty-printed JSON.
	 */
	function buildLine( icon, text, payload, editUrl, viewUrl, viewText ) {
		const line = el( 'span', { className: 'wp-ai-chat-line' }, [
			icon ? el( 'span', { className: 'wp-ai-chat-line-icon', text: icon, attrs: { 'aria-hidden': 'true' } } ) : null,
			el( 'span', { className: 'wp-ai-chat-line-text', text } ),
			editUrl ? externalLink( editUrl, 'Edit', 'wp-ai-chat-action-link' ) : null,
			viewUrl ? externalLink( viewUrl, viewText || 'View', 'wp-ai-chat-action-link' ) : null,
		] );

		if ( ! payload ) {
			return el( 'div', { className: 'wp-ai-chat-line-wrap' }, [ line ] );
		}

		const details = el( 'details', { className: 'wp-ai-chat-details' }, [
			el( 'summary', {}, [ line ] ),
			el( 'pre', { className: 'wp-ai-chat-payload', text: JSON.stringify( payload, null, 2 ) } ),
		] );
		details.open = debugOn;
		return details;
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
		const shown = keys.slice( 0, 3 ).map( ( key ) => key + ': ' + shortValue( args[ key ] ) );
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
		Object.keys( result ).forEach( ( key ) => {
			if ( Array.isArray( result[ key ] ) && 'warnings' !== key && parts.length < 4 ) {
				parts.push( pluralize( result[ key ].length, key.replace( /_/g, ' ' ).replace( /s$/, '' ) ) );
			}
		} );
		[ 'total', 'count', 'replaced', 'block_count' ].forEach( ( key ) => {
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

		return parts.length ? parts.slice( 0, 5 ).join( ' · ' ) : fallback || 'done';
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

	/* ------------------------------------------------------------------ *
	 * Markdown (model replies)
	 * ------------------------------------------------------------------ */

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
	 * bullet/numbered lists, tables, **bold**, *italic*, `code`, [links](url) and bare URLs.
	 * Everything is HTML-escaped first; only http(s) links become <a>.
	 */
	function renderMarkdown( text ) {
		return escapeHtml( text || '' )
			.replace( /\r\n/g, '\n' )
			.trim()
			.split( /\n{2,}/ )
			.map( renderBlock )
			.join( '' );
	}

	const BULLET = /^\s*[-*•]\s+/;
	const NUMBERED = /^\s*\d+[.)]\s+/;
	// The |---|:---:| line under a table's header row.
	const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

	/** One block of already-escaped text (no blank lines inside). */
	function renderBlock( block ) {
		const lines = block.split( '\n' ).filter( ( l ) => '' !== l.trim() );
		if ( ! lines.length ) {
			return '';
		}

		// A table can sit in the middle of a block: render the text around it separately.
		const tableStart = lines.findIndex( ( l, i ) => l.includes( '|' ) && TABLE_DIVIDER.test( lines[ i + 1 ] || '' ) );
		if ( -1 !== tableStart ) {
			let tableEnd = tableStart + 2;
			while ( tableEnd < lines.length && lines[ tableEnd ].includes( '|' ) ) {
				tableEnd++;
			}
			return (
				renderBlock( lines.slice( 0, tableStart ).join( '\n' ) ) +
				renderTable( lines.slice( tableStart, tableEnd ) ) +
				renderBlock( lines.slice( tableEnd ).join( '\n' ) )
			);
		}

		if ( lines.every( ( l ) => BULLET.test( l ) ) ) {
			return renderList( 'ul', lines, BULLET );
		}
		if ( lines.every( ( l ) => NUMBERED.test( l ) ) ) {
			return renderList( 'ol', lines, NUMBERED );
		}
		const heading = lines[ 0 ].match( /^(#{1,4})\s+(.+)$/ );
		if ( heading && 1 === lines.length ) {
			return '<p class="wp-ai-chat-md-heading">' + renderInline( heading[ 2 ] ) + '</p>';
		}
		return '<p>' + lines.map( renderInline ).join( '<br>' ) + '</p>';
	}

	function renderList( tag, lines, marker ) {
		return '<' + tag + '>' + lines.map( ( l ) => '<li>' + renderInline( l.replace( marker, '' ) ) + '</li>' ).join( '' ) + '</' + tag + '>';
	}

	/** Header row, divider row, then body rows. Wrapped so wide tables scroll, not overflow. */
	function renderTable( lines ) {
		const cells = ( line ) => line.trim().replace( /^\|/, '' ).replace( /\|$/, '' ).split( '|' ).map( ( c ) => c.trim() );
		const row = ( line, tag ) => '<tr>' + cells( line ).map( ( c ) => '<' + tag + '>' + renderInline( c ) + '</' + tag + '>' ).join( '' ) + '</tr>';

		return (
			'<div class="wp-ai-chat-table-wrap"><table class="wp-ai-chat-table">' +
			'<thead>' + row( lines[ 0 ], 'th' ) + '</thead>' +
			'<tbody>' + lines.slice( 2 ).map( ( l ) => row( l, 'td' ) ).join( '' ) + '</tbody>' +
			'</table></div>'
		);
	}

	/** Inline Markdown on already-escaped text. */
	function renderInline( str ) {
		const stashed = [];
		const stash = ( html ) => {
			stashed.push( html );
			return '\u0000' + ( stashed.length - 1 ) + '\u0000';
		};
		const anchor = ( url, label ) => '<a href="' + url + '" target="_blank" rel="noopener">' + label + '</a>';

		// Inline code first so its contents aren't formatted.
		str = str.replace( /`([^`]+)`/g, ( m, code ) => stash( '<code>' + code + '</code>' ) );
		// [label](https://…)
		str = str.replace( /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, ( m, label, url ) => stash( anchor( url, label ) ) );
		// Bare URLs (trailing punctuation stays outside the link).
		str = str.replace( /\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, ( url ) => stash( anchor( url, url ) ) );

		str = str
			.replace( /\*\*([^*]+)\*\*/g, '<strong>$1</strong>' )
			.replace( /(^|[^*\w])\*([^*\s][^*]*)\*(?=[^*\w]|$)/g, '$1<em>$2</em>' );

		return str.replace( /\u0000(\d+)\u0000/g, ( m, i ) => stashed[ Number( i ) ] );
	}

	/* ------------------------------------------------------------------ *
	 * Confirmations and revision cards
	 * ------------------------------------------------------------------ */

	/** Destructive ability calls are held server-side; show Confirm / Cancel for each. */
	function renderConfirmations( card, confirmations ) {
		if ( ! card || ! Array.isArray( confirmations ) || ! confirmations.length ) {
			return;
		}
		confirmations.forEach( ( c ) => {
			const isChoice = 'revision_choice' === c.mode;
			const isPublish = 'publish_revision' === c.mode;

			let question = c.label + summarizeArgs( c.args );
			if ( isChoice ) {
				question = 'Change "' + ( c.target_title || 'this page' ) + '"? It\'s live.';
			} else if ( isPublish ) {
				question = 'Publish your changes to "' + c.target_title + '"? This replaces the live page.';
			}

			const choices = isChoice
				? [
						[ 'Make a revision (preview first)', true, 'revision' ],
						[ 'Change live page now', false, 'confirm' ],
						[ 'Cancel', false, 'cancel' ],
				  ]
				: [
						[ isPublish ? 'Publish' : c.label, true, 'confirm' ],
						[ 'Cancel', false, 'cancel' ],
				  ];

			const buttons = el( 'div', { className: 'wp-ai-chat-confirm-buttons' } );
			const box = el( 'div', { className: 'wp-ai-chat-confirm' }, [
				el( 'div', { className: 'wp-ai-chat-confirm-text' }, [
					buildLine( '?', question, isPublish ? null : { args: c.args || {} } ),
				] ),
				buttons,
			] );
			buttons.append(
				...choices.map( ( [ text, primary, decision ] ) =>
					button( text, primary, () => resolveConfirmation( c, decision, box, buttons ) )
				)
			);

			insertBeforeMeta( card, box );
		} );
		scrollToBottom();
	}

	/**
	 * "What next" card after a revision is created or changed:
	 * preview it, publish it over the live page, or ask for more changes.
	 */
	function renderRevisionCards( card, revisions ) {
		if ( ! card || ! Array.isArray( revisions ) || ! revisions.length ) {
			return;
		}
		revisions.forEach( ( r ) => {
			const previewUrl = httpUrl( r.preview_url );
			const buttons = el( 'div', { className: 'wp-ai-chat-confirm-buttons' } );
			const box = el( 'div', { className: 'wp-ai-chat-confirm wp-ai-chat-revision-card' }, [
				el( 'div', { className: 'wp-ai-chat-confirm-text' }, [
					buildLine( '✎', 'Your revision of "' + r.target_title + '" is ready. The live page hasn\'t changed.' ),
				] ),
				buttons,
			] );
			buttons.append(
				...[
					previewUrl && externalLink( previewUrl, 'Preview', 'button' ),
					button( 'Publish', true, () => resolveConfirmation( r, 'confirm', box, buttons ) ),
					el( 'span', { className: 'wp-ai-chat-revision-hint', text: 'Want changes? Just tell me what to change.' } ),
				].filter( Boolean )
			);

			insertBeforeMeta( card, box );
		} );
		scrollToBottom();
	}

	async function resolveConfirmation( c, decision, box, buttons ) {
		const isPublish = 'publish_revision' === c.mode;
		buttons.querySelectorAll( 'button' ).forEach( ( b ) => {
			b.disabled = true;
		} );
		buttons.append( el( 'span', { className: 'wp-ai-chat-confirm-working', text: 'cancel' === decision ? '' : 'Working…' } ) );

		// The box stays where it was (buttons replaced by what was clicked); the outcome
		// arrives as a new message at the bottom of the chat, like any other reply.
		const clicked = { confirm: isPublish ? 'Publish' : 'Confirm', revision: 'Make a revision', cancel: 'Cancel' }[ decision ] || decision;
		const finish = ( line, state ) => {
			buttons.replaceWith( el( 'div', { className: 'wp-ai-chat-confirm-clicked', text: 'You clicked: ' + clicked } ) );
			box.classList.add( 'is-resolved' );
			const event = el(
				'div',
				{ className: 'wp-ai-chat-message wp-ai-chat-message--assistant wp-ai-chat-message--event ' + ( state || '' ) },
				[ line ]
			);
			ui.messages.append( event );
			scrollToBottom();
			return event;
		};

		let data;
		try {
			data = await api( '/confirmations/' + encodeURIComponent( c.token ), { method: 'POST', data: { decision } } );
		} catch ( error ) {
			finish( buildLine( '✗', errorMessage( error, 'Request failed. Nothing was confirmed.' ) ), 'is-error' );
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
			const event = finish(
				buildLine(
					ok ? '✓' : '✗',
					ok
						? 'Revision of "' + rev.original_title + '" updated · live page unchanged'
						: 'Revision created, but the change failed · ' + ( result.error || 'failed' ),
					{ revision: rev, result },
					httpUrl( rev.edit_url ),
					httpUrl( rev.preview_url ),
					'Preview'
				),
				ok ? 'is-success' : 'is-error'
			);
			renderRevisionCards( event, data.revisions );
			return;
		}

		if ( isPublish && ok ) {
			finish(
				buildLine(
					'✓',
					'"' + ( result.title || c.target_title ) + '" is live with your changes',
					{ result },
					null,
					httpUrl( result.live_url ),
					'View page'
				),
				'is-success'
			);
			return;
		}

		finish(
			buildLine(
				ok ? '✓' : '✗',
				( data.label || c.label ) + ' · ' + ( ok ? result.message || summarizeResult( result, true, 'done' ) : result.error || 'failed' ),
				{ result },
				extractEditUrl( result ),
				ok ? httpUrl( result.live_url ) : null
			),
			ok ? 'is-success' : 'is-error'
		);
	}

	/* ------------------------------------------------------------------ *
	 * Start
	 * ------------------------------------------------------------------ */

	ui.form.addEventListener( 'submit', ( event ) => {
		event.preventDefault();
		sendPrompt();
	} );

	ui.prompt.addEventListener( 'keydown', ( event ) => {
		if ( 'Enter' === event.key && ! event.shiftKey ) {
			event.preventDefault();
			sendPrompt();
		}
	} );

	if ( ui.abilitiesToggle ) {
		ui.abilitiesToggle.addEventListener( 'click', toggleAbilities );
		loadAbilities();
	}

	loadModels();
	loadState();

	if ( ! ui.messages.children.length ) {
		addMessage( "Hi! I'm your AI assistant. What would you like me to help you with?", 'assistant' );
	}
} )();
