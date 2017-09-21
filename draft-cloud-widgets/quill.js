// This implements simple_widget based on the Quill rich text
// editor at quilljs.com.

var uaparser = require('ua-parser-js');

var simple_widget = require('./simple_widget.js').simple_widget;

var jot = require('jot');
var jotvals = require('jot/jot/values.js');
var jotseqs = require('jot/jot/sequences.js');
var jotobjs = require('jot/jot/objects.js');

exports.quill = function(elem, quill_options, baseurl) {
  // check that Quill supports this browser
  run_browser_check();

  // init
  this.elem = elem;
  this.baseurl = baseurl || "";

  // Default options.
  this.quill_options = quill_options || { };
  if (!this.quill_options.modules)
    this.quill_options.modules = { };
  if (!this.quill_options.formats) // formats that are closest to what's available in CommonMark
    this.quill_options.formats = ['bold', 'italic', 'code', 'link', 'blockquote', 'header', 'list', 'code-block', 'image'];
  if (!this.quill_options.modules.toolbar)
    this.quill_options.modules.toolbar =  [
      ['bold', 'italic', 'code'],
      [{ 'header': 1 }, { 'header': 2 },
       { 'list': 'ordered' }, { 'list': 'bullet' }, 'blockquote', 'code-block'],
      ['link', 'image'],
      ['clean']
      ];
  if (!this.quill_options.theme)
    this.quill_options.theme = 'snow';

  // Must start it off readonly because the widget has not been initialized
  // with content yet.
  this.quill_options['readOnly'] = true;

  // Must set this so that undo/redo skips over remote users' changes.
  if (!this.quill_options.modules.history) this.quill_options.modules.history = { };
  this.quill_options.modules.history.userOnly = true;
}

function run_browser_check() {
  var ua = uaparser();

  function parse_version(version) {
    return version.split(/\./).map(function(item) { return parseInt(item); });
  }

  function check(engine, min_version, warning) {
    if (ua.engine.name != engine)
      return; // not this engine
    if (jot.cmp(
      parse_version(ua.engine.version),
      parse_version(min_version)) >= 0)
      return; // version is ok
    alert(warning + " or later is required to edit the document on this page.");
    throw new Error("Quill does not support this browser version.")
  }

  // Based on https://github.com/quilljs/quill/#readme but
  // converting the browser versions to engine versions for
  // better reliability in checking, hopefully.
  check("Gecko", "44", "Firefox version 44"); // engine number == browser number
  if (ua.browser.name == "Safari" || ua.browser.name == "Mobile Safari")
    check("WebKit", "601", "Safari version 9");
  else
    check("WebKit", "537.36", "Chrome version 47"); // https://en.wikipedia.org/wiki/Google_Chrome_version_history
  check("Trident", "7.0", "Internet Explorer 11"); // https://en.wikipedia.org/wiki/Trident_%28layout_engine%29#Release_history
  check("EdgeHTML", "13", "Edge 13");
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
  var dist_url = this.baseurl + "/static/quill";
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

  // Add a span to the toolbar for showing saved state.
  var toolbar = this.elem.previousSibling;
  this.saved_state_indicator = document.createElement('span');
  this.saved_state_indicator.setAttribute("class", "ql-formats");
  this.saved_state_indicator.setAttribute("style", "margin-left: 1em; font-style: italic; color: #666;");
  toolbar.appendChild(this.saved_state_indicator);

  var _this = this;

  if (this.quill_options.sizeTo == "container") {
    // Correctly size the editor to the parent node's size minus the toolbar size.
    function resize() { _this.elem.style.height = (_this.elem.parentNode.clientHeight - toolbar.offsetHeight) + "px"; }
    window.addEventListener("resize", resize);
    resize();
  }

  this.logger("Quill widget created");

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
exports.quill.prototype.show_message = function(level, message) {
  alert(message);
}

exports.quill.prototype.show_status = function(message) {
  this.saved_state_indicator.textContent = message;
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

// cursor support

exports.quill.prototype.get_cursor_char_range = function() {
  var sel = this.editor.getSelection();
  if (!sel) return null;
  return [sel.index, sel.length];
}

exports.quill.prototype.get_cursors_parent_element = function() {
  return this.elem;
}

exports.quill.prototype.get_peer_cursor_rects = function(index, length) {
  return [this.editor.getBounds(index, length)];
}

exports.quill.prototype.on_change_at_charpos = function(cb) {
  this.editor.on('text-change', function(delta, oldDelta, source) {
    cb(compute_cursor_positions_shift(delta));
  });
}

function compute_cursor_positions_shift(delta) {
  // Update the cursor positions. Since the cursor positions shift
  // due to remote changes, but remote changes come asynchronously
  // with cursor update messages, we should update cursor positions
  // as fast as possible. Turn the delta into an array of [index,
  // length, newlength] triples that the CursorManager can handle.
  var index = 0;
  var changeinfo = [];
  delta.ops.forEach(function(op) {
    if (op.insert) {
      var length = (typeof op.insert == "string" ? op.insert.length : 1);
      changeinfo.push([index, 0, length]);
    }
    if (op.delete) {
      var length = op.delete;
      changeinfo.push([index, length, 0]);
      index += length;
    }
    if (op.retain) {
      var length = op.retain;
      index += length;
    }
  });
  return changeinfo;
}
