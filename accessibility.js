// Copyright 2014 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.



/**
 * AccessibilityManager receives the app view hierarchy from Android and
 * renders the hierarchy to DOM elements for accessibility services to consume.
 * @constructor
 */
function AccessibilityManager(plugin) {
  this.plugin_ = plugin;

  plugin.addMessageListener('jsAccessibility', this.handleMessage.bind(this));
}


/**
 * The IDs of all accessibility nodes are prefixed with this string.
 * @const
 * @private
 */
AccessibilityManager.prototype.ID_PREFIX_ = 'accessibility';


/**
 * The root node of the accessibility hierarchy will have this ID.  CSS styles
 * are applied to this node and its children.
 * @const
 * @private
 */
AccessibilityManager.prototype.ROOT_NODE_ID_ = 'accessibility-root';


/**
 * Handle messages from the ArcAccessibilityService.
 */
AccessibilityManager.prototype.handleMessage = function(message) {
  if (message.command !== 'setViewHierarchy') {
    console.error('Unknown command received in AccessibilityManager:' +
        message.command);
    return;
  }
  var event = message.data;
  var nodeHierarchy = event['accessibilityNodeHierarchy'];
  var windowId = event['windowId'];

  var accessibilityHtml = this.convertTreeToHtml_(nodeHierarchy, windowId);
  accessibilityHtml.id = this.ROOT_NODE_ID_;

  // Save the ID of the element with focus to restore focus later if needed.
  var activeElementId = '';
  if (document.activeElement !== null)
    activeElementId = document.activeElement.id;

  var previousAccessibilityHtml = document.getElementById(this.ROOT_NODE_ID_);
  if (previousAccessibilityHtml !== null)
    previousAccessibilityHtml.remove();

  document.body.appendChild(accessibilityHtml);

  // If the element that previously had focus was an accessibility node, find
  // its new element in the new tree and give it focus if it exists.
  if (activeElementId.indexOf(this.ID_PREFIX_) === 0) {
    var nodeToFocus = document.getElementById(activeElementId);
    if (nodeToFocus !== null) {
      nodeToFocus.focus();
    }
  }
};


/**
 * Takes the JSON representation of a AccessibilityNodeInfo tree and converts
 * it to HTML elements.
 * @private
 */
AccessibilityManager.prototype.convertTreeToHtml_ =
    function(nodeData, windowId) {
  var htmlElement = this.convertNodeToHtml_(nodeData, windowId);

  var children = nodeData['children'];
  if (children !== undefined) {
    for (var i = 0; i < children.length; i++) {
      childDiv = this.convertTreeToHtml_(children[i], windowId);
      htmlElement.appendChild(childDiv);
    }
  }

  return htmlElement;
};


/**
 * Send a message to the ArcAccessibilityService indicating a click happened.
 * @private
 */
AccessibilityManager.prototype.sendClickEvent_ = function(windowId, nodeId) {
  var response = {
    namespace: 'androidAccessibility',
    command: 'performAction',
    data: {
      eventType: 'click',
      windowId: windowId,
      nodeId: nodeId
    }
  };
  this.plugin_.postMessage(response);
};


/**
 * Convert a single AccessibilityNodeInfo to HTML elements.
 * @private
 */
AccessibilityManager.prototype.convertNodeToHtml_ =
    function(nodeData, windowId) {
  var containingElement;
  // TODO(crbug.com/394080) Improve this mapping from Android widgets to HTML
  // elements.
  if (nodeData['clickable']) {
    containingElement = document.createElement('button');
    // TODO(crbug.com/394080) We need to capture focus events and send them to
    // Android as well.
    containingElement.onclick =
        this.sendClickEvent_.bind(this, windowId, nodeData['nodeId']);
  } else {
    containingElement = document.createElement('div');
  }

  containingElement.id = this.ID_PREFIX_ + nodeData['nodeId'];

  var text = nodeData['text'];
  if (text !== undefined && text !== '') {
    var textNode = document.createTextNode(text);
    containingElement.appendChild(textNode);
  }

  containingElement.style.setProperty('left', nodeData['left'] + 'px');
  containingElement.style.setProperty(
      'top', (nodeData['top'] + _TOPBAR_HEIGHT) + 'px');
  var width = nodeData['right'] - nodeData['left'];
  var height = nodeData['bottom'] - nodeData['top'];
  containingElement.style.setProperty('width', width + 'px');
  containingElement.style.setProperty('height', height + 'px');

  // TODO(crbug.com/394080): Filter objects that are off screen.
  return containingElement;
};
