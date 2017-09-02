// This implements simple_widget based on the Quill rich text
// editor at quilljs.com.

var simple_widget = require('./simple_widget.js').simple_widget;

var jotvals = require('../jot/values.js');
var jotseqs = require('../jot/sequences.js');
var jotobjs = require('../jot/objects.js');

exports.quill = function(elem, quill_options) {
  this.elem = elem;

  // Default options.
  this.quill_options = quill_options || {
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
}

exports.quill.prototype = new simple_widget(); // inherit

exports.quill.prototype.name = "quill Widget";

exports.quill.prototype.prepare_dom_async = function(callback) {
  if (typeof Quill == "object") {
    // Quill is already loaded on the page.
    this.prepare_dom_async2(callback);
    return;
  }

  this.logger("adding Quill CSS/JS tags to the DOM");

  // Add CSS and SCRIPT tags for quill.
  var dist_url = "/static/quill";
  var elem = document.createElement('link');
  elem.href = dist_url + "/quill.snow.css";
  elem.rel = "stylesheet";
  elem.type = "text/css";
  document.getElementsByTagName('head')[0].appendChild(elem);

  var elem = document.createElement('script');
  elem.src = dist_url + "/quill.min.js";
  var _this = this;
  elem.onload = function() {
    // Once the script loads, we can create the Quill editor.
    _this.prepare_dom_async2(callback);
  }
  document.getElementsByTagName('head')[0].appendChild(elem);
}

exports.quill.prototype.prepare_dom_async2 = function(callback) {
  // Initialize editor in read-only mode.
  this.editor = new Quill(this.elem, this.quill_options);

  // Initialize cursors.
  this.cursor_container = this.elem;
  this.cursors = { };

  this.logger("Quill widget created");

  // Update cursors.
  var _this = this;
  this.editor.on('text-change', function(delta, oldDelta, source) {
    update_cursor_positions(_this, delta);
  });

  callback();
}

exports.quill.prototype.get_document = function() {
  // Quill gives us an array of delta objects with a __proto__
  // attribute that will confuse jot.diff because it has
  // functions. Make sure we return a plain JSONable data
  // structure. If we don't rewrite it below, we should do
  // JSON.parse(JSON.stringify(document));

  // Additionally, it has long runs of text. If formatting
  // is changed on a slice of a long run of text, then the
  // run is broken up into smaller pieces and jot.diff will
  // see this as a delete & insert. We can fix this by
  // breaking up long runs here. The resulting data structure
  // will still be equivalent, from Quill's point of view,
  // it just won't be compact. And createDelta won't mind
  // because the resulting delta is about characters anyway.
  var ops = [];
  this.editor.getContents().ops.forEach(function(op) {
    // Pass embeds unchanged.
    if (typeof op.insert != "string") {
      var op1 = { insert: op.insert };
      if (op.attributes) op1.attributes = op.attributes;
      ops.push(op1);
      return;
    }

    // Split the insert on whitespace. Retain the attributes on
    // each word.
    op.insert.split(/( +)/).forEach(function(word) {
      if (word.length == 0) return; // shouldn't be possible?
      var op1 = { insert: word };
      if (op.attributes) op1.attributes = op.attributes;
      ops.push(op1);
    })
  });
  return { ops: ops };
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
      var delta = createDelta(this.get_document(), patch);
      this.editor.updateContents(delta, 'api');
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

exports.quill.prototype.get_ephemeral_state = function() {
  return { quill_selection: this.editor.getSelection() };
}

var cursor_colors = [ // copied from http://clrs.cc/
  "#001f3f", "#0074D9", "#39CCCC", "#3D9970", "#2ECC40",
  "#85144b", "#F012BE", "#B10DC9"
];

exports.quill.prototype.on_peer_state_updated = function(peerid, user, state) {
  if (!user || !state || !state.quill_selection) {
    // Peer disconnected.
    if (peerid in this.cursors) {
      this.cursors[peerid].widget.parentNode.removeChild(this.cursors[peerid].widget);
      delete this.cursors[peerid];
    }
    return;
  }

  // New?
  if (!(peerid in this.cursors)) {
    this.cursors[peerid] = {
    };

    var widget = document.createElement('div');
    widget.setAttribute('class', 'quill-editor-peer-cursor');
    widget.setAttribute('style', 'position: absolute;');
    this.cursor_container.appendChild(widget);

    var widget_bar = document.createElement('div');
    widget.appendChild(widget_bar);
    widget_bar.setAttribute('class', 'quill-editor-peer-cursor-bar');
    widget_bar.setAttribute('style', 'width: 0; height: 0; border-left: 2px solid black;');

    var widget_name = document.createElement('div');
    widget.appendChild(widget_name);
    widget_name.setAttribute('class', 'quill-editor-peer-cursor-name');
    widget_name.setAttribute('style', 'cursor: pointer; color: white; font-weight: bold; border: 1px solid black; border-radius: .5em; padding: .125em; font-size: 90%; max-width: 12em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;');

    this.cursors[peerid].widget = { widget: widget, bar: widget_bar, name: widget_name };
  }

  // Update.
  this.cursors[peerid].peerid = peerid;
  this.cursors[peerid].user = user;
  this.cursors[peerid].state = state;
  update_cursor(this.editor, this.cursors[peerid]);
}

function update_cursor(quill, peer_state) {
  // Update bounds.
  var bounds = quill.getBounds(peer_state.state.quill_selection.index, peer_state.state.quill_selection.length);
  peer_state.widget.widget.style.top = bounds.top + "px";
  peer_state.widget.widget.style.left = (bounds.left-2) + "px";
  peer_state.widget.bar.style.height = bounds.height + "px";

  // Update color. Map the user's peerid stably to a color choice.
  // Since peerid's are random, we can use that as a numerical starting
  // point.
  var color_code = 0;
  for (var i = 0; i < peer_state.peerid.length; i++) color_code += peer_state.peerid.charCodeAt(i);
  var color = cursor_colors[color_code % cursor_colors.length];
  peer_state.widget.name.style.backgroundColor = color;
  peer_state.widget.name.style.borderColor = color;
  peer_state.widget.bar.style.borderColor = color;

  // Update name.
  peer_state.widget.name.innerHTML = peer_state.user.name;
}

function update_cursor_positions(me, delta) {
  // Update the cursor positions. Since the cursor positions shift
  // due to remote changes, but remote changes come asynchronously
  // with cursor update messages, we should update cursor positions
  // as fast as possible.
  console.log(me.cursors);
  for (var peerid in me.cursors) {
    var qs = me.cursors[peerid].state.quill_selection;
    console.log(qs);
    var index = 0;
    delta.ops.forEach(function(op) {
      if (index > qs.index)
        return;
      if (op.insert) {
        var dx = (typeof op.insert == "string" ? op.insert.length : 1);
        qs.index += dx;
        index += dx;
      }
      if (op.delete) {
        qs.index -= op.delete;
        index += op.delete;
      }
      if (op.retain)
        index += op.retain;
    });
    update_cursor(me.editor, me.cursors[peerid]);
  }
}

exports.quill.prototype.show_message = function(level, message) {
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
            if (hunk.offset > 0)
              delta.ops.push({ retain: hunk.offset });
            charindex += hunk.offset;
            if (hunk.length > 0) delta.ops.push({ delete: hunk.length });
            var insert = hunk.op.apply(d.insert.slice(charindex,charindex+hunk.length));
            if ((typeof insert != "string") || insert.length > 0) delta.ops.push({ insert: insert, attributes: d.attributes });
            charindex += hunk.length;
          });

          // Retain any characters at the end of the PATCH.
          if (d.insert.length-charindex > 0)
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
      if (total_chars_deleted > 0)
        delta.ops.push({ delete: total_chars_deleted });

      // Insert an insert with the new content.
      delems = hunk.op.apply(delems);
      delems.forEach(function(d) { delta.ops.push(d); });
    }
  });

  return delta;
}