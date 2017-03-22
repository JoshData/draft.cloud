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
    update_document: function(patch) {
      var current_content = textarea.value;
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




