/*
 * This module implements a widget for <textarea> and, despite
 * the name, also <input type='text'> elements.
 */

var simple_widget = require('./simple_widget.js').simple_widget;
var jot = require('jot');

var getCaretCoordinates = require('textarea-caret');

exports.textarea = function(elem) {
  // Set the elements's UI to a holding state before initial content is loaded.
  this.elem = elem;
  this.elem.value = "";
  this.elem.readOnly = true;
  this.elem.style.textRendering = "geometricPrecision"; // necessary on WebKit for cursor location calculation to work

  // Record changes on keypresses of whitespace since that's a nice time to
  // send a chunk of changes to the server, preserving some logical intent.
  var _this = this;
  this.elem.addEventListener("keypress", function(e) {
    if (/^\s+$/.exec(e.key))
      _this.compute_changes();
  })

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
    saved_status_badge.textContent = message;
    saved_status_badge.setAttribute("style", saved_status_badge_style); // force display to get dimensions
    var bbox = elem.getBoundingClientRect();
    var dims = saved_status_badge.getBoundingClientRect();
    var top = bbox.top + bbox.height - dims.height - 2;
    var left = bbox.left + bbox.width - dims.width - 2 - 15; // 15 is for a righthand scrollbar
    saved_status_badge.setAttribute("style", saved_status_badge_style + "; top: " + top + "px; left: " + left + "px");
  }

  var debug_random_op_interval = /#randomopinterval=(\d+)/.exec(window.location.hash);
  if (debug_random_op_interval) {
    setInterval(
      function() {
        if (elem.readOnly) return;
        var doc = elem.value;

        // Construct a random operation toward the beginning of the
        // document and of a relatively short length.
        var start = Math.floor(Math.random() * Math.random() * (doc.length+1));
        var length = (start < doc.length) ? Math.floor(Math.random() * Math.random() * (doc.length - start + 1)) : 0;

        // Construct a random operation on that part and mutate the text.
        // Coerce to a string.
        var rangetext = doc.slice(start, start+length);
        rangetext = ""+jot.createRandomOp(rangetext).apply(rangetext);

        // Apply it to the element.
        var op = new jot.SPLICE(start, length, rangetext);
        doc = op.apply(doc);
        elem.value = doc;
      },
      debug_random_op_interval[1]
    )
  }
}

exports.textarea.prototype = new simple_widget(); // inherit

exports.textarea.prototype.name = "Textarea Widget";

// required methods

exports.textarea.prototype.get_document = function() {
  return this.elem.value; 
}

exports.textarea.prototype.set_readonly = function(readonly) {
  this.elem.readOnly = readonly;
  if (!readonly)
    this.elem.focus();
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
  var selection = [this.elem.selectionStart, this.elem.selectionEnd];
  if (patch) {
    try {
      var r = new jot.SPLICE(
        selection[0],
        selection[1]-selection[0],
        (selection[1] != selection[0]) ? "" : "X") // any value that prevents it from becoming a no-op
        .rebase(patch, { document: this.elem.value });
      selection = [r.hunks[0].offset, r.hunks[r.hunks.length-1].offset+r.hunks[r.hunks.length-1].length]; // if successful
    } catch (e) {
      console.log("could not update cursor position", e);
    }
  }
  this.elem.value = document;
  this.elem.selectionStart = selection[0];
  this.elem.selectionEnd = selection[1];
}

exports.textarea.prototype.show_message = function(level, message) {
  alert(message);
}

exports.textarea.prototype.show_status = function(message) {
  this.update_saved_status_badge(message);
}

// cursor support

exports.textarea.prototype.get_cursor_char_range = function() {
  return [this.elem.selectionStart, this.elem.selectionEnd-this.elem.selectionStart];
}

exports.textarea.prototype.get_cursors_parent_element = function() {
  return this.elem.parentNode;
}

exports.textarea.prototype.get_peer_cursor_rects = function(index, length) {
  // pos.height is returned starting with https://github.com/component/textarea-caret-position/commit/af904838644c60a7c48b21ebcca8a533a5967074
  // which is not yet released
  var pos = getCaretCoordinates(this.elem, index);
  return [{ top: this.elem.offsetTop + pos.top, left: this.elem.offsetLeft + pos.left, width: 0, height: pos.height }];
}

exports.textarea.prototype.on_change_at_charpos = function(cb) {
  // TODO. This is not very good. There are lots of ways content
  // changes, and we have no way to understand what the change
  // was exactly so we can revise the cursor positions.
  var _this = this;
  this.elem.addEventListener("keydown", function(e) {
    var length = 1; // TODO: Not all keypresses result in same length.
    cb([[_this.elem.selectionStart, _this.elem.selectionEnd-_this.elem.selectionStart, length]]);
  })
}