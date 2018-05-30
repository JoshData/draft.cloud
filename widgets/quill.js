// This implements simple_widget based on the Quill rich text
// editor at quilljs.com.

var uaparser = require('ua-parser-js');

var simple_widget = require('./simple_widget.js').simple_widget;

var jot = require('jot');
var jotvals = require('jot/jot/values.js');
var jotseqs = require('jot/jot/sequences.js');
var jotlists = require('jot/jot/lists.js');
var jotobjs = require('jot/jot/objects.js');

exports.quill = function(elem, quill_options, baseurl) {
  // check that Quill supports this browser
  run_browser_check();

  // init
  this.elem = elem;
  this.value_elem = null;
  this.baseurl = baseurl || "";

  // If we got a <textarea> element, put a DIV below it, make the textarea
  // hidden, and update the textarea with the Quill editor's value whenever
  // it's changed (TODO).
  if (this.elem.tagName == "TEXTAREA") {
    this.value_elem = this.elem;
    this.value_elem.style.display = "none";
    this.elem = document.createElement("div");
    this.value_elem.parentNode.insertBefore(this.elem, this.value_elem);
  }

  // Add a DIV around elem that will handle scrolling. We need an extra one
  // because Quill's default holds the document content, and we need a place
  // to put cursors inside the scrolling div but outside the document. Give
  // it relative positioning so cursor coordinates are relative to it.
  this.scrollingContainer = document.createElement("div");
  this.elem.parentNode.insertBefore(this.scrollingContainer, this.elem);
  this.scrollingContainer.appendChild(this.elem);
  this.scrollingContainer.setAttribute("style", "position: relative;");

  // Add a DIV above the scrollingContainer for the toolbar so that the toolbar'
  // position is fixed.
  this.toolbarContainer = document.createElement("div");
  this.toolbarContainer.setAttribute('id', "toolbar_" + Math.random().toString(36).substring(7));
  this.scrollingContainer.parentNode.insertBefore(this.toolbarContainer, this.scrollingContainer);

  // Default options.
  this.quill_options = quill_options || { };
  this.quill_options.scrollingContainer = this.scrollingContainer;
  if (!this.quill_options.modules)
    this.quill_options.modules = { };
  if (!this.quill_options.formats) // formats that are closest to what's available in CommonMark
    this.quill_options.formats = ['bold', 'italic', 'code', 'link', 'blockquote', 'header', 'list', 'indent', 'code-block', 'image'];
  if (!this.quill_options.modules.toolbar)
    this.quill_options.modules.toolbar =  [
      ['bold', 'italic', 'code'],
      [{ 'header': 1 }, { 'header': 2 },
       { 'list': 'ordered' }, { 'list': 'bullet' },
       { 'indent': '-1'}, { 'indent': '+1' },
       'blockquote', 'code-block'],
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

  // Move the toolbar outside of the scrolling container.
  var toolbar = this.elem.previousSibling;
  this.toolbarContainer.appendChild(toolbar);

  // Remove the 'height' on the ql-container and ql-editor divs, which otherwise
  // creates scrollbars around the document, since we use our own element for scrolling.
  // Remove the border because our container has the border. Set a min height to
  // fill our container so that the whole area gets a text cursor.
  this.elem.style.height = "auto";
  this.elem.style.minHeight = "100%";
  this.elem.style.border = "none";
  this.elem.getElementsByClassName("ql-editor")[0].style.height = "auto";
  this.elem.getElementsByClassName("ql-editor")[0].style.minHeight = "100%";

  // Add a span to the toolbar for showing saved state.
  // Use min-width to prevent the toolbar from jumping around
  // when the size of the element changes.
  this.saved_state_indicator = document.createElement('span');
  this.saved_state_indicator.setAttribute("class", "ql-formats");
  this.saved_state_indicator.setAttribute("style", "margin-left: 1em; font-size: 95%; letter-spacing: -.5px; font-style: italic; color: #666; min-width: 5.5em;");
  toolbar.appendChild(this.saved_state_indicator);

  var _this = this;

  if (this.quill_options.sizeTo == "container") {
    // Correctly size the editor to the parent node's size minus the toolbar size.
    this.scrollingContainer.setAttribute("style", "position: relative; height: 100%; overflow-y: auto;");
    function resize() { _this.scrollingContainer.style.height = (_this.scrollingContainer.parentNode.clientHeight - toolbar.offsetHeight) + "px"; }
    window.addEventListener("resize", resize);
    resize();
  }

  // Listen for text-change events.
  this.change_flag = false;
  this.editor.on("text-change", function(delta, oldDelta, source) {
    _this.change_flag = true;
  })

  this.logger("Quill widget created");

  // For debugging...
  var random_edit_interval = /#debug_with_random_edits=(\d+)/.exec(window.location.hash);
  if (random_edit_interval) {
    setInterval(
      function() { _this.make_random_edit() },
      random_edit_interval[1]
    )
  }

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
      // The top-level of the patch must be an APPLY on an 'ops'
      // key with a single PATCH operation or a LIST of operations.
      if (!(patch instanceof jotobjs.APPLY)) throw "not an APPLY";
      if (!("ops" in patch.ops)) throw "not an APPLY on 'ops'";
      var ops;
      if (patch.ops['ops'] instanceof jotseqs.PATCH)
        ops = [patch.ops['ops']];
      else if (patch.ops['ops'] instanceof jotlists.LIST)
        ops = patch.ops['ops'].ops.filter(function(item) {
          if (!(item instanceof jotseqs.PATCH))
            throw "not an APPLY on 'ops' with PATCH or LIST or PATCHES";
          return true;
        });
      else
        throw "not an APPLY on 'ops' with PATCH or LIST";
      var _this = this;
      ops.forEach(function(op) {
        var delta = createDelta(_this.get_document(), op);
        _this.editor.updateContents(delta, 'api');
      })
      return; // success
    } catch (e) {
      // fail, fall through to below
      this.logger("error applying " + patch.inspect() + ":");
      this.logger(e);
    }
  }

  // Fall back to calling .setContents() and blowing away the user's current
  // caret/scroll position.
  this.editor.setContents(document);
  this.change_flag = false;
}

exports.quill.prototype.show_message = function(level, message) {
  alert(message);
}

exports.quill.prototype.show_status = function(message) {
  this.saved_state_indicator.textContent = message;
}

exports.quill.prototype.get_change_flag = function() {
  return this.change_flag;
}

exports.quill.prototype.clear_change_flag = function() {
  this.change_flag = false;
}

function createDelta(current_doc, patch) {
  // Convert a JOT operation to a Quill Delta.

  // We're given a JOT operation that applies to the logical
  // structure of this.get_document(), but we're going to apply
  // the logical changes instead to the Quill editor itself.
  // We'll need to compare the operation to the current document
  // structure in order to create a Quill Delta instance.

  // Move to the operations on the 'ops' attribute at the top
  // of the document structure.
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
          // were removed. If attrib_delta is MISSING, the whole attributes
          // object were removed.
          if (attrib_delta === jotobjs.MISSING) attrib_delta = {};
          for (var key in d.attributes)
            if (attrib_delta === jotobjs.MISSING || !(key in attrib_delta))
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
  return this.scrollingContainer;
}

exports.quill.prototype.get_peer_cursor_rects = function(index, length) {
  // Quill.getBounds returns a single rectangle that compasses the
  // selection range. For multi-line selections, the bounding box
  // includes the start of the first selected line and the end of
  // the last selected line, which is incorrect. We need to return
  // multiple rectangles, at a minimum: the rectangle for the first
  // line from the start of the selection to the end of the line,
  // the retangle for middle lines all of which are selected, and
  // the rectangle for the last line up to the end of the selection
  
  var rects = [this.editor.getBounds(index, length)];

  // Get the cursor position of the start position. If it is at a
  // different left/top than the bounding-box rect, insert a new
  // rect at the start and adjust the bounding-box rect to not
  // include it. There's an edge case when an empty line is selected
  // at the start or end of the selection, the single-point selection's
  // top/bottom don't match the bounding box top/bottom, and in those
  // cases the bounding box is better so don't revise it.
  var start = this.editor.getBounds(index, 0);
  if (start.left > rects[0].left && start.top == rects[0].top) {
    start.width = rects[0].left + rects[0].width - start.left; // extent point select to end of line
    rects[0].top += start.height; // start bounding box below this line
    rects[0].height -= start.height;
    rects.unshift(start);
  }
  
  // Get the cursor position of the end position. If it is at a
  // different right/bottom than the bounding-box rect, insert a new
  // rect at the end and adjust the bounding-box rect to not
  // include it.
  var end = this.editor.getBounds(index+length, 0);
  if (end.right < rects[rects.length-1].right && end.bottom == rects[rects.length-1].bottom) {
    end.width = end.left - rects[rects.length-1].left; // extent point select back to start of line
    end.left = rects[rects.length-1].left;
    rects[rects.length-1].height -= end.height; // start bounding box below this line
    rects.push(end);
  }

  return rects;
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

// For debugging...
exports.quill.prototype.make_random_edit = function() {
  // Compute random permutations on the document.
  var doc = this.editor.getContents();
  var delta = [];

  if (doc.ops.length == 0) {
    // Create initial content.
    delta.push({
      insert: (jot.createRandomValue()+"")
    })
  } else {
    // Create edits.
    var index = 0;
    var firstindex = null;
    doc.ops.forEach(function(op) {
      if (Math.random() < 1/delta.length) {
        // Make an edit here.
        if (Math.random() < .5) {
          // change formatting
          delta.push({ retain: typeof op.insert == "string" ? op.insert.length : 1,
            attributes: { bold: Math.random() < .5, italic: Math.random() < .5 } });
        } else if (Math.random() < .1) {
          // delete
          delta.push({ delete: typeof op.insert == "string" ? op.insert.length : 1 });
        } else if (Math.random() < .5) {
          // replace text
          delta.push({ delete: typeof op.insert == "string" ? op.insert.length : 1 });
          delta.push({ insert: ""+jot.createRandomOp(op.insert).apply(op.insert) });
        } else if (Math.random() < .5) {
          // insert paragraph here
          delta.push({ insert: "\n" });
        } else {
          // insert here
          delta.push({ insert: jot.createRandomValue()+"" });
        }

        if (firstindex == null) firstindex = index;
      } else {
        // retain        
        delta.push({ retain: typeof op.insert == "string" ? op.insert.length : 1 });
      }

      index += (delta[delta.length-1].insert||"").length || (delta[delta.length-1].retain||0);
    });
  }

  this.editor.updateContents({ ops: delta }, "api");
  this.editor.setSelection(firstindex);
}
