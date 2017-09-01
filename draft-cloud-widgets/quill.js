// This implements simple_widget based on the Quill rich text
// editor at quilljs.com.

var simple_widget = require('./simple_widget.js').simple_widget;

var jotvals = require('../jot/values.js');
var jotseqs = require('../jot/sequences.js');
var jotobjs = require('../jot/objects.js');

// Add CSS and SCRIPT tags for quill.
var dist_url = "/static/quill";
var elem = document.createElement('link');
elem.href = dist_url + "/quill.snow.css";
elem.rel = "stylesheet";
elem.type = "text/css";
document.getElementsByTagName('head')[0].appendChild(elem);
var elem = document.createElement('script');
elem.src = dist_url + "/quill.min.js";
document.getElementsByTagName('head')[0].appendChild(elem);

exports.quill = function(elem, dist_url, quill_options) {
  // Default options.
  quill_options = quill_options || {
    modules: {
      toolbar: [
        ['bold', 'italic'],
        ['blockquote', 'code-block'],
        [{ 'header': 1 }, { 'header': 2 }, { 'header': 3 }],
        [{ 'list': 'ordered'}, { 'list': 'bullet' }],
        [{ 'indent': '-1'}, { 'indent': '+1' }],
        [{ 'direction': 'rtl' }],
        ['clean']
      ]
    },
    //placeholder: 'Compose an epic...',
    readOnly: true,
    theme: 'snow'
  };
  // Initialize editor in read-only mode.
  var _this = this;
  this.editor = new Quill(elem, quill_options);
}

exports.quill.prototype = new simple_widget(); // inherit

exports.quill.prototype.name = "quill Widget";

exports.quill.prototype.get_document = function() {
  // Quill gives us an array of delta objects with a __proto__
  // attribute that will confuse jot.diff because it has
  // functions. Convert to a JSONable data structure.
  var document = this.editor.getContents();
  document = JSON.parse(JSON.stringify(document));
  return document; 
}

exports.quill.prototype.set_readonly = function(readonly) {
  this.editor.enable(!readonly);
  if (!readonly)
    this.editor.focus();
}

exports.quill.prototype.set_document = function(document, patch) {
  // Calling .setContents() with the new document will likely be very
  // disruptive. Instead, translate the provided JOT operation in patch
  // to a Quill Delta, and apply the Delta. If we can't figure out how
  // to apply patch, then just fall back to setContents.
  if (patch) {
    try {
      this.editor.updateContents(createDelta(this.get_document(), patch), 'api');
      return; // success
    } catch (e) {
      // fail, fall through to below
      console.log(e);
    }
  }

  // Fall back to calling .setContents() and blowing away the user's current
  // caret/scroll position.
  this.editor.setContents(document);
}

exports.quill.prototype.nonfatal_error = function(message) {
  alert(message);
}

exports.quill.prototype.show_status = function(message) {
  // TODO
}

function createDelta(current_doc, patch) {
  // Convert a JOT operation to a Quill Delta.

  // We're given a JOT operation that applies to the logical
  // structure of this.get_document(), but we're going to apply
  // the logical changes instead to the Quill editor itself.
  // We'll need to compare the operation to the current document
  // structure in order to create a Quill Delta instance.

  // The top-level of the patch must be an APPLY on an 'ops'
  // key with a single PATCH operation (TODO: Or maybe list?).
  if (!(patch instanceof jotobjs.APPLY)) throw "not an APPLY";
  if (!("ops" in patch.ops)) throw "not an APPLY on 'ops'";
  if (!(patch.ops['ops'] instanceof jotseqs.PATCH)) throw "not an APPLY on 'ops' with PATCH";
  
  // Move to the operations on the 'ops' attribute at the top
  // of the document structure.
  patch = patch.ops['ops'];
  current_doc = current_doc.ops;

  // Create a new Delta instance. (There's a whole library for this
  // but I'm not sure how it's exposed by Quill.)
  var delta = { ops: [] };
  patch.hunks.forEach(function(hunk) {
    // Retain everything before this hunk. Issue a 'retain' with the
    // total number of characters in the document skiped over by this
    // hunk.
    for (var i = 0; i < hunk.offset; i++) {
      var d = current_doc.shift();
      delta.ops.push({
        retain: typeof d.insert == "string"
                  ? d.insert.length // number of characters
                  : 1 // embeds have "length 1"
      });
    }

    // If the hunk op is a MAP, then we can apply the operation
    // to each subsequent entry in the current document delta.
    // (Usually this is applied to a single index.)
    if (hunk.op instanceof jotseqs.MAP) {
      var innerop = hunk.op.op;
      for (var i = 0; i < hunk.length; i++) {
        // Apply the inner-inner operation to the single Delta entry
        // at the next position.
        var d = current_doc.shift();

        if (innerop instanceof jotobjs.APPLY
          && Object.keys(innerop.ops).length == 1
          && "attributes" in innerop.ops) {
          // Only the attributes are being changed. Construct a new
          // attributes object indicating the change. First apply
          // the operation to the old attributes.
          var attrib_delta = innerop.ops['attributes'].apply(d.attributes);

          // Then add back nulls for missing keys to indicate they
          // were removed.
          for (var key in d.attributes)
            if (!(key in attrib_delta))
              attrib_delta[key] = null;

          // Add a "retain" with attributes change.
          delta.ops.push({
            retain: typeof d.insert == "string"
                      ? d.insert.length // number of characters
                      : 1, // embeds have "length 1"
            attributes: attrib_delta
          });

        } else if (innerop instanceof jotobjs.APPLY
                   && Object.keys(innerop.ops).length == 1
                   && "insert" in innerop.ops
                   && innerop.ops["insert"] instanceof jotseqs.PATCH
                   && typeof d.insert == "string"
                   && typeof innerop.apply(d).insert == "string") {

          // The operation is changing just the text part of this
          // part of the document content. We can apply a more precise
          // delta than replacing the whole thing, using a delete/insert
          // just on the changed character ranges. Attributes from the
          // orignal document are carried through to new characters.
          var charindex = 0;
          innerop.ops["insert"].hunks.forEach(function(hunk) {
            if (hunk.offset)
              delta.ops.push({ retain: hunk.offset });
            charindex += hunk.offset;
            delta.ops.push({ delete: hunk.length });
            delta.ops.push({ insert: hunk.op.apply(d.insert.slice(charindex,charindex+hunk.length)), attributes: d.attributes });
            charindex += hunk.length;
          });

          // Retain any characters at the end of the PATCH.
          if (d.insert.length-charindex)
            delta.ops.push({ retain: d.insert.length-charindex });
        

        } else {
          // This element is changed by a more complex operation, so
          // add a pair of delete and insert operations.
          delta.ops.push({
            delete: typeof d.insert == "string"
                      ? d.insert.length // number of characters
                      : 1 // embeds have "length 1"
          });

          // The insert is just the value of the element after the
          // operation is applied.
          delta.ops.push(innerop.apply(d));
        }
      }

    } else {
      // The hunk operation is perhaps...
      //   a SET that is replacing this range with another range
      //   something else weird
      // We'll just replace all of the document content in this range.

      // Insert a delete.
      var delems = [];
      var total_chars_deleted = 0;
      for (var i = 0; i < hunk.length; i++) {
        var d = current_doc.shift();
        total_chars_deleted += typeof d.insert == "string"
                      ? d.insert.length // number of characters
                      : 1; // embeds have "length 1"
        delems.push(d);
      }
      delta.ops.push({ delete: total_chars_deleted });

      // Insert an insert with the new content.
      delems = hunk.op.apply(delems);
      delems.forEach(function(d) { delta.ops.push(d); });
    }
  });

  console.log(patch.inspect(), delta);
  return delta;
}