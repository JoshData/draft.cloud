/*
 * This module implements a widget for <form>s, creating
 * widgets for any form controls that we have a widget for.
 *
 * TODO: There's no need for this to be a subclass of simple_widget
 * because the form doesn't need to do any diffing of its own state,
 * since the inner widgets handle that. Make this a top-level class.
 */

var simple_widget = require('./simple_widget.js').simple_widget;
var async = require("async");

exports.form = function(elem, options, baseurl) {
  this.elem = elem;
  this.options = options || {};
  this.baseurl = baseurl;
  this.widgets = { };

  // Initialize widgets.
  var elems = []
    .concat([].slice.call(this.elem.getElementsByTagName("input"), 0))
    .concat([].slice.call(this.elem.getElementsByTagName("textarea"), 0))
    .concat([].slice.call(this.elem.getElementsByTagName("select"), 0));
  for (var i = 0; i < elems.length; i++)
    this.init_form_elem(elems[i]);
}

exports.form.prototype = new simple_widget(); // inherit

exports.form.prototype.name = "Form Widget";

exports.form.prototype.init_form_elem = function(elem) {
  // Make an internal ID as a key name to track this element & widget.
  var id = elem.id ? "id_" + elem.id : elem.name;
  if (!id) return;
  
  // What widget to use?
  var widget;
  if (elem.tagName == "TEXTAREA" && elem.getAttribute("data-widget") == "quill")
    widget = require("./quill.js").quill;
  else if (elem.tagName == "TEXTAREA")
    widget = require("./textarea.js").textarea;
  else if (elem.tagName == "INPUT"
    && (  // nb. email and number types don't support selection
         elem.getAttribute("type") == "text"
      || elem.getAttribute("type") == "password"
      || elem.getAttribute("type") == "tel"
      || elem.getAttribute("type") == "url"
    ))
    widget = require("./textarea.js").textarea;
  else if (elem.tagName == "SELECT")
    widget = require("./select.js").select;
  else
    return;

  widget = new widget(elem, (this.options["controls"]||{})[id], this.baseurl);

  this.widgets[id] = {
    elem: elem,
    widget: widget
  };
}

exports.form.prototype.initialize = function(logger, callback) {
  var funcs = [];
  for (var w in this.widgets) {
    (function() { // create a closure
      var widget = this.widgets[w].widget;
      funcs.push(function(cb) { widget.initialize(logger, cb); });
    }).apply(this);
  }
  async.parallel(funcs, function(err) {
    callback();
  })
}

// required methods

exports.form.prototype.get_document = function() {
  // Form the document by querying the widgets.
  var doc = { };
  for (var w in this.widgets)
    doc[w] = this.widgets[w].widget.get_document();
  return doc;
}

exports.form.prototype.set_readonly = function(readonly) {
  // Set all of the widgets to readonly/not readonly.
  for (var w in this.widgets)
    this.widgets[w].widget.set_readonly(readonly);
}

exports.form.prototype.set_document = function(document, patch) {
  // Pass the value down.
  for (var w in this.widgets) {
    var widget_doc = null;
    if (document != null && typeof document == "object" && w in document)
      widget_doc = document[w];
    this.widgets[w].widget.set_document(widget_doc, patch ? patch.drilldown(w) : null);
  }
}

exports.form.prototype.show_message = function(level, message) {
  alert(message);
}

exports.form.prototype.show_status = function(message) {
  for (var w in this.widgets)
    this.widgets[w].widget.show_status(message);
}

exports.form.prototype.get_ephemeral_state = function() {
  var state = { };
  for (var w in this.widgets)
    state[w] = this.widgets[w].widget.get_ephemeral_state();
  return state;
}

exports.form.prototype.on_peer_state_updated = function(peerid, user, state) {
  for (var w in this.widgets)
    this.widgets[w].widget.on_peer_state_updated(peerid, user, (state === null) ? state : (state[w] || null));
}