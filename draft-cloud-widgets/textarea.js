var simple_widget = require('./simple_widget.js').simple_widget;
var jot = require('../jot');

exports.textarea = function(textarea) {
  // Set the textarea's UI to a holding state before initial content is loaded.
  this.textarea = textarea;
  textarea.value = "";
  textarea.readOnly = true;

  // Make a widget that shows saved status.
  var saved_status_badge_style = "position: absolute; border: 1px solid #AAA; background-color: rgba(255,255,255,.85); padding: 2px; font-size: 11px; border-radius: 5px; cursor: default";
  var saved_status_badge = document.createElement("div");
  saved_status_badge.setAttribute("class", "draftdotcloud-saved-status");
  saved_status_badge.setAttribute("style", "display: none; " + saved_status_badge_style);
  document.getElementsByTagName("body")[0].append(saved_status_badge);
  this.update_saved_status_badge = function(message) {
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
}

exports.textarea.prototype = new simple_widget(); // inherit

exports.textarea.prototype.name = "Textarea Widget";

exports.textarea.prototype.get_document = function() {
  return this.textarea.value; 
}

exports.textarea.prototype.set_readonly = function(readonly) {
  this.textarea.readOnly = readonly;
  if (!readonly)
    this.textarea.focus();
}

exports.textarea.prototype.set_document = function(document, patch) {
  // If the document is new, its content is null. Don't
  // put a null in the textarea. The document will immediately
  // generate a change to the empty string.
  document = (typeof document === "string") ? document : "";

  // Get the current selection state, revise the textarea,
  // and then restore the selection state. Since the selection
  // can shift due to remote changes, represent it as an
  // operation, rebase it, and then pull the selection state
  // out from that.
  var selection = [this.textarea.selectionStart, this.textarea.selectionEnd];
  if (patch) {
    try {
      var r = new jot.SPLICE(
        selection[0],
        selection[1]-selection[0],
        document.slice(selection[0], selection[1]))
        .rebase(patch);
      selection = [r.hunks[0].offset, r.hunks[r.hunks.length-1].offset+r.hunks[r.hunks.length-1].length]; // if successful
    } catch (e) {
      console.log("could not update cursor position", e);
    }
  }
  this.textarea.value = document;
  this.textarea.selectionStart = selection[0];
  this.textarea.selectionEnd = selection[1];
}

exports.textarea.prototype.nonfatal_error = function(message) {
  alert(message);
}

exports.textarea.prototype.show_status = function(message) {
  this.update_saved_status_badge(message);
}

////

exports.textarea_cursors = function(textarea) {
  this.textarea = textarea;

  // hack to get a unique id for this client (TODO should be given by the server)
  this.myId = Math.random().toString(36).slice(2);

  // dom elements
  this.carets = { };
}

exports.textarea_cursors.prototype = new simple_widget(); // inherit

exports.textarea_cursors.prototype.get_document = function(base_content) {
  // Update my cursor position.
  var content = { };
  if (typeof base_content == "object" && base_content !== null) {
    for (var key in base_content)
      content[key] = base_content[key];
  }
  content[this.myId] = [
    (this.myId in content) ? content[this.myId][0] : Date.now(),
    this.textarea.selectionStart,
    (this.textarea.selectionEnd==this.textarea.selectionStart) ? null : this.textarea.selectionEnd
  ];
  return content;
}

exports.textarea_cursors.prototype.set_document = function(content) {
  var bbox = this.textarea.getBoundingClientRect();
  var getCaretCoordinates = require('textarea-caret');
  var users = Object.keys(content);
  for (var i = 0; i < users.length; i++) {
    var userid = users[i];

    // Skip ourself.
    if (userid == this.myId)
      continue;

    var cursor = content[userid];

    // Skip stale cursors.
    if (Date.now() - cursor[0] > 1000*60)
      continue;

    // Draw it.
    var pos = getCaretCoordinates(this.textarea, cursor[1]);
    var node;
    if (!(userid in this.carets)) {
      node = document.createElement("div");
      document.getElementsByTagName("body")[0].append(node);
      this.carets[userid] = node;
    } else {
      node = this.carets[userid];
    }
    node.setAttribute("style", "position: absolute; background-color: red; width: 1.5px; height: 1em; "
      + "left: " + (bbox.left+pos.left) + "px; top: " + (bbox.top+pos.top) + "px")
  }
}

exports.textarea_cursors.prototype.set_readonly = function(readonly) {
}

exports.textarea_cursors.prototype.nonfatal_error = function(message) {
}

exports.textarea_cursors.prototype.show_status = function(message) {
}


