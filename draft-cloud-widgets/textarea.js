var jot = require("../jot");

exports.textarea_widget = function(textarea) {
  // Set the textarea's UI to a holding state before initial content is loaded.
  textarea.value = "";
  textarea.readOnly = true;

  // Track the base content to see when changes are made.
  var base_content;

  // The callback to the client for any changes.
  var pushfunc;

  // Make a widget that shows saved status.
  var saved_status_badge_style = "position: absolute; border: 1px solid #AAA; background-color: rgba(255,255,255,.85); padding: 2px; font-size: 11px; border-radius: 5px; cursor: default";
  var saved_status_badge = document.createElement("div");
  saved_status_badge.setAttribute("class", "draftdotcloud-saved-status");
  saved_status_badge.setAttribute("style", "display: none; " + saved_status_badge_style);
  document.getElementsByTagName("body")[0].append(saved_status_badge);
  function update_saved_status_badge(message) {
    if (!message) {
      saved_status_badge.setAttribute("style", "display: none; " + saved_status_badge_style);
      return;
    }
    saved_status_badge.innerHTML = message;
    saved_status_badge.setAttribute("style", saved_status_badge_style); // force display to get dimensions
    var bbox = textarea.getBoundingClientRect();
    var dims = saved_status_badge.getBoundingClientRect();
    var top = bbox.top + bbox.height - dims.height - 2;
    var left = bbox.left + bbox.width - dims.width - 2 - 15; // 15 is for a righthand scrollbar
    saved_status_badge.setAttribute("style", saved_status_badge_style + "; top: " + top + "px; left: " + left + "px");
  }

  function poll_for_changes() {
    // Has the document changed locally since the last fetched content?
    var current_content = textarea.value;
    if (current_content != base_content) {
      var patch = jot.diff(base_content, current_content);
      pushfunc(patch);
      base_content = current_content;
    }

    // Run again in a little while.
    setTimeout(poll_for_changes, 333);
  }

  return {
    initialize: function(state, pushfunccb) {
      base_content = state.content;

      // If the document is new, its content is null. Don't
      // put a null in the textarea. The document will immediately
      // generate a change to the empty string.
      textarea.value = typeof state.content === "string" ? state.content : "";
      textarea.selectionStart = 0; // Chrome likes to put the cursor at the end
      textarea.selectionEnd = 0;
      if (!state.readonly) {
        textarea.readOnly = false;
        textarea.focus();
      }

      // Start polling for changes.
      pushfunc = pushfunccb;
      poll_for_changes();
    },
    nonfatal_error: function(message) {
      alert(message);
    },
    get_document: function() {
      return textarea.value; 
    },
    update_document: function(current_content, patch) {
      var new_content = patch.apply(current_content);

      // Get the current selection state, revise the textarea,
      // and then restore the selection state. Since the selection
      // can shift due to remote changes, represent it as an
      // operation, rebase it, and then pull the selection state
      // out from that.
      var selection = [textarea.selectionStart, textarea.selectionEnd];
      try {
        var selectionMod = [
          new jot.INS(selection[0], "!").rebase(patch).hunks[0].offset,
          new jot.INS(selection[1], "!").rebase(patch).hunks[0].offset,
        ];
        selection = selectionMod; // if successful
      } catch (e) {
      }
      textarea.value = new_content;
      textarea.selectionStart = selection[0];
      textarea.selectionEnd = selection[1];
      base_content = new_content;
    },
    status: update_saved_status_badge
  };
}

exports.textarea_cursor_widget = function(textarea) {
  // Track the base content to see when changes are made.
  var base_content;

  // The callback to the client for any changes.
  var pushfunc;

  // ugh a hack
  var myId = Math.random().toString(36).slice(2);

  // dom elements
  var carets = { };

  function draw_cursors(content) {
    var bbox = textarea.getBoundingClientRect();
    var getCaretCoordinates = require('textarea-caret');
    Object.keys(content).forEach(function(userid) {
      var cursor = content[userid];

      // Skip ourself.
      if (userid == myId)
        return;

      // Skip stale cursors.
      if (Date.now() - cursor[0] > 1000*60)
        return;

      // Draw it.
      var pos = getCaretCoordinates(textarea, cursor[1]);
      var node;
      if (!(userid in carets)) {
        node = document.createElement("div");
        document.getElementsByTagName("body")[0].append(node);
        carets[userid] = node;
      } else {
        node = carets[userid];
      }
      node.setAttribute("style", "position: absolute; background-color: red; width: 1.5px; height: 1em; "
        + "left: " + (bbox.left+pos.left) + "px; top: " + (bbox.top+pos.top) + "px")

    });
  }

  function get_current_document() {
    // Update my cursor position.
    var content = { };
    if (typeof base_content == "object" && base_content !== null) {
      for (var key in base_content)
        content[key] = base_content[key];
    }
    content[myId] = [
      (myId in content) ? content[myId][0] : null,
      textarea.selectionStart,
      (textarea.selectionEnd==textarea.selectionStart) ? null : textarea.selectionEnd
    ];
    return content;
  }

  function poll_for_changes() {
    // Has the document changed locally since the last fetched content?

    // Get the structured document content.
    var current_content = get_current_document();

    // Check for changes.
    var deepEqual = require("deep-equal");
    if (!deepEqual(base_content, current_content)) {
      // add a timer just when it changes
      current_content[myId][0] = Date.now();

      var patch = jot.diff(base_content, current_content);
      pushfunc(patch);
      base_content = current_content;
      draw_cursors(base_content);
    }

    // Run again in a little while.
    setTimeout(poll_for_changes, 333);
  }

  return {
    initialize: function(state, pushfunccb) {
      base_content = state.content;

      // Start polling for changes.
      pushfunc = pushfunccb;
      poll_for_changes();
    },
    nonfatal_error: function(message) {
      alert(message);
    },
    get_document: get_current_document,
    update_document: function(current_content, patch) {
      var new_content = patch.apply(current_content);

      draw_cursors(new_content);

      // From here on, diffs of content are compared against this new content.
      base_content = new_content;
    },
    status: function() { }
  };
}



