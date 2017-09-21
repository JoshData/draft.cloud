/*
 * This module implements a widget for <select> elements.
 */

var simple_widget = require('./simple_widget.js').simple_widget;

var jot = require('jot');

exports.select = function(elem, options, baseurl) {
  this.elem = elem;
  this.options = options || {};
  this.baseurl = baseurl;

  // Call compute_changes() whenever the value is changed.
  var _this = this;
  this.elem.addEventListener("change", function(e) {
    _this.compute_changes();
  })
}

exports.select.prototype = new simple_widget(); // inherit

exports.select.prototype.name = "Select Widget";

exports.select.prototype.poll_interval = 0; // no need to poll

// required methods

exports.select.prototype.get_document = function() {
  // simple select
  if (!this.elem.multiple)
    return this.elem.value;

  // multiple select
  var values = { };
  for (var i = 0; i < this.elem.options.length; i++)
    if (this.elem.options[i].selected)
      values[this.elem.options[i].value] = true;
  return values;
}

exports.select.prototype.set_readonly = function(readonly) {
  this.elem.disabled = readonly;
}

exports.select.prototype.set_document = function(document, patch) {
  // simple select
  if (!this.elem.multiple || (typeof document != "object")) {
    this.elem.value = document;

  } else {
    // multiple select

    // Update the selected state of each option.
    for (var i = 0; i < this.elem.options.length; i++) {
      var key = this.elem.options[i].value;

      // the naive way - update to current document value
      var newstate = (key in document);

      if (patch instanceof jot.APPLY) {
        // This option is not affected. Don't over-write any
        // uncommitted local changes to the selected state
        // of this option.
        if (!(key in patch.ops))
          continue;

        // Get new selected state of this key by applying the
        // inner operation to the current state of the option.
        newstate = patch.ops[key].apply(this.elem.options[i].selected);
        if (newstate !== true) // false is representing by the absence of a key, i.e. the jot MISSING sentinel
          newstate = false;
      }

      this.elem.options[i].selected = newstate;
    }
  }

}

exports.select.prototype.show_message = function(level, message) {
  alert(message);
}

exports.select.prototype.show_status = function(message) {
  // TODO
}

exports.select.prototype.get_ephemeral_state = function() {
  return { focused: this.elem == document.activeElement };
}

exports.select.prototype.on_peer_state_updated = function(peerid, user, state) {
}