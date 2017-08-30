// This bundles our Javascript resources for the client.
// Build with:
//
// browserify -d draft-cloud-widgets/browserfy_root.js -o public_html/draftdotcloud.js
//

// Let other initialization occur before we actually start initialization.
setTimeout(init, 0);

var log_receivers = [];

function init() {
  //var channel = require("./ajax_polling.js");
  var channel = require("./websocket.js");

  var textareas = document.getElementsByTagName("textarea");
  for (var i = 0; i < textareas.length; i++) {
    var elem = textareas[i];
    var owner_name = elem.getAttribute("data-draftdotcloud-owner");
    var document_name = elem.getAttribute("data-draftdotcloud-document");
    var api_key = elem.getAttribute("data-draftdotcloud-apikey");
    if (owner_name && document_name) {
      console.log("attaching draft.cloud widget to", elem);
      var widget = require("./textarea.js").textarea;
      widget = new widget(elem);
      var client = require("./client.js").Client(
        owner_name,
        document_name,
        api_key,
        channel,
        widget,
        function(doc, msg) {
          log_receivers.forEach(function(recip) {
            recip(doc, msg);
          })
        }
      );

      var cursor_document_name = elem.getAttribute("data-draftdotcloud-cursordocument");
      if (cursor_document_name) {
        console.log("...with cursors");
        var cursorwidget = require("./textarea.js").textarea_cursors;
        cursorwidget = new cursorwidget(elem);
        var cursorclient = require("./client.js").Client(
          owner_name,
          cursor_document_name,
          api_key,
          channel,
          cursorwidget,
          function(doc, msg) {
            log_receivers.forEach(function(recip) {
              recip(doc, msg);
            })
          }
        );

      }
    }
  }
}

global.draft_cloud_on_event = function(log_recipient) {
  log_receivers.push(log_recipient);
}
