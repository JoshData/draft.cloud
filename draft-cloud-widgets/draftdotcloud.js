// This is the entry point for bundling our Javascript resources for the
// Draft.cloud client.
//
// Build with:
//
// browserify -d draft-cloud-widgets/draftdotcloud.js -o public_html/draftdotcloud.js
//

// Let other initialization occur before we actually start initialization.
setTimeout(init, 1);

var log_receivers = [];

function init() {
  // Activate any elements with data-draftdotcloud-{owner,document,apikey}
  // attributes.
  var elements = document.getElementsByClassName("draftdotcloud-widget");
  for (var i = 0; i < elements.length; i++) {
    var elem = elements[i];

    var widget;

    // <textarea>s always get the textarea widget.
    if (elem.tagName == "TEXTAREA")
      widget = require("./textarea.js").textarea;

    // <input type=text>s always get the (mis-named) textarea widget.
    else if (elem.tagName == "INPUT"
      && elem.getAttribute("type") == "text")
      widget = require("./textarea.js").textarea;

    // <div>s can have any other widget
    else if (elem.tagName == "DIV"
      && elem.getAttribute("data-draftdotcloud-widget") == "jsoneditor")
      widget = require("./jsoneditor.js").jsoneditor;
    else if (elem.tagName == "DIV"
      && elem.getAttribute("data-draftdotcloud-widget") == "quill")
      widget = require("./quill.js").quill;

    else
      // invalid
      continue;

    var owner_name = elem.getAttribute("data-draftdotcloud-owner");
    var document_name = elem.getAttribute("data-draftdotcloud-document");
    var api_key = elem.getAttribute("data-draftdotcloud-apikey");
    var baseurl = elem.getAttribute("data-draftdotcloud-baseurl");
    if (!owner_name || !document_name) continue;

    var websocket = require("./websocket.js");
    if (baseurl) websocket.baseurl = baseurl;

    if (typeof draftdotcloud_widget_options == "undefined") draftdotcloud_widget_options = null;

    var client = require("./client.js").Client(
      owner_name,
      document_name,
      api_key,
      websocket, // or require("./ajax_polling.js")
      new widget(elem, draftdotcloud_widget_options, baseurl),
      function(doc, msg) {
        log_receivers.forEach(function(recip) {
          recip(doc, msg);
        })
      }
    );
  }
}

global.draft_cloud_on_event = function(log_recipient) {
  log_receivers.push(log_recipient);
}
