var simple_widget = require('./simple_widget.js').simple_widget;
var jot = require('jot');
var jotvals = require('jot/jot/values.js');
var jotseqs = require('jot/jot/sequences.js');
var jotobjs = require('jot/jot/objects.js');


exports.jsoneditor = function(elem) {
  this.elem = elem;
}

exports.jsoneditor.prototype = new simple_widget(); // inherit

exports.jsoneditor.prototype.name = "jsoneditor Widget";

exports.jsoneditor.prototype.prepare_dom_async = function(callback) {
  if (typeof jsoneditor == "object") {
    // already loaded on the page
    this.prepare_dom_async2(callback);
    return;
  }

  this.logger("adding jsoneditor CSS/JS tags to the DOM");

  // Add CSS and SCRIPT tags for jsoneditor.
  var dist_url = "/static/jsoneditor";
  var elem = document.createElement('link');
  elem.href = dist_url + "/jsoneditor.min.css";
  elem.rel = "stylesheet";
  elem.type = "text/css";
  document.getElementsByTagName('head')[0].appendChild(elem);
  var elem = document.createElement('script');
  elem.src = dist_url + "/jsoneditor.min.js";
  var _this = this;
  elem.onload = function() {
    // Once the script loads, we can create the Quill editor.
    _this.prepare_dom_async2(callback);
  }
  document.getElementsByTagName('head')[0].appendChild(elem);
}

exports.jsoneditor.prototype.prepare_dom_async2 = function(callback) {
  // Initialize editor in read-only mode.
  var _this = this;
  this.editor = new JSONEditor(elem, {
    mode: 'view',
    onChange: function() { _this.compute_changes(); }
  });

  callback();
}

exports.jsoneditor.prototype.get_document = function() {
  return this.editor.get(); 
}

exports.jsoneditor.prototype.set_readonly = function(readonly) {
  this.editor.setMode(readonly ? "view" : "tree");
  if (!readonly)
    this.editor.focus();
}

exports.jsoneditor.prototype.set_document = function(document, patch) {
  // Calling .set() with the new document will cause the cursor to
  // reset. Use the editor's undocumented History class to structurally
  // update the document, if possible.

  if (patch && this.editor.node) {
    // We're given not only the new document content but also a JOT operation
    // that represents the change being made. If we can understand the JOT
    // operation, we can apply it directly to the editor.
    try {
      apply(patch, this.editor.node);
      return; // success
    } catch (e) {
      // fail, fall through to below
      console.log(e);
    }
  }

  // Fall back to calling .set().
  this.editor.set(document);
}

exports.jsoneditor.prototype.show_message = function(level, message) {
  alert(message);
}

exports.jsoneditor.prototype.show_status = function(message) {
  // TODO
}

function apply(patch, node) {
  if (patch instanceof jotvals.SET) {
    console.log(patch, node, patch.value);
    node.setValue(patch.value, "auto");
    node.updateDom();

  } else if (patch instanceof jotvals.MATH) {
    node.setValue(patch.apply(node.getValue()), "auto");
    node.updateDom();

  } else if (patch instanceof jotobjs.APPLY) {
    Object.keys(patch.ops).forEach(function(key) {
      // Get child node.
      child = node.childs.filter(function (child) {
        return child.field === key;
      })[0];
      if (!child) {
        child = Node(node.editor);
        node.appendChild(child);
      }

      // Apply op to child.
      apply(patch.ops[key], child);
    });

  } else if (patch instanceof jotseqs.PATCH && 0) {
    // TODO: Strings vs arrays.
    var index = 0;
    patch.hunks.forEach(function(hunk) {
      index += hunk.offset;
      if (hunk.op instanceof jotseqs.MAP) {
        // Get child node & apply to child.
        var child = node.childs[index];
        if (!child)
          throw "JOT operation refers to invalid index";
        apply(hunk.op.op, child);
      } else {
        throw "unsupported JOT operation inside PATCH " + hunk.op.inspect();
      }
      index += hunk.length + hunk.op.get_length_change(hunk.length);
    });

  } else {
    throw "unsupported JOT operation " + patch.inspect();
  }
}
