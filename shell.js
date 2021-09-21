// Copyright 2014 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
//
// Shell javascript code.



/**
 * @constructor
 *
 * Sets up a component interface for interacting with a shell.
 *
 * @param plugin Plugin instance.
 */
function Shell(plugin) {
  /** @private */
  this.plugin_ = plugin;

  /** @private */
  this.nextId_ = 0;

  /** @private */
  this.sessions_ = {};

  /** @private */
  this.pendingJobs_ = [];

  /** @private */
  this.androidReady_ = false;

  plugin.addMessageListener('jsShell', this.handleMessage_.bind(this));
}


/**
 * @public
 *
 * Passes a command to the shell, and handles getting back the response/output.
 *
 * @param commandLine Commandline to run.
 * @param onDataCallback Called to handle data returned from the
 * shell.
 * @param onClosedCallback Called when the shell connection is
 * closed.
 * @return Promise to be resolved when the shell command is executed. The
 *         resolve object is Session object.
 **/
Shell.prototype.shell = function(
    commandLine, onDataCallback, onClosedCallback) {
  var self = this;

  return new Promise(function(resolve, reject) {
    var postAndroidShellMessage = function() {
      var id = self.nextId_++;
      var session = {
        id_: id,
        onDataCallback_: onDataCallback,
        onClosedCallback_: onClosedCallback
      };
      session.close = self.close_.bind(self, session);

      self.sessions_[id] = session;

      var message = {
        namespace: 'androidShell',
        command: 'open',
        data: {
          id: id,
          commandLine: commandLine
        }
      };
      self.plugin_.postMessage(message);

      resolve(session);
    };

    if (self.androidReady_) {
      postAndroidShellMessage();
    } else {
      // If JavaScriptShell is not ready to listen messages, send it later when
      // the ready message arrives.
      self.pendingJobs_.push(postAndroidShellMessage);
    }
  });
};


/**
 * @private
 *
 * Closes the shell session.
 *
 * @param session Session to close.
 **/
Shell.prototype.close_ = function(session) {
  var message = {
    namespace: 'androidShell',
    command: 'close',
    data: {
      id: session.id_
    }
  };
  this.plugin_.postMessage(message);
};


/**
 * @private
 *
 * Internal handler for shell output. Dispatches to the correct callback
 * registered for the specific command it was in response to.
 *
 * @param message Output from the shell.
 */
Shell.prototype.handleMessage_ = function(message) {
  console.assert(message.namespace == 'jsShell');

  if (message.command == 'ready') {
    this.androidReady_ = true;
    // The JavaScriptShell is ready. Execute pending jobs if exist.
    for (var i = 0; i < this.pendingJobs_.length; ++i) {
      this.pendingJobs_[i].call();
    }
    this.pendingJobs_ = [];
    return;
  }

  var session = this.sessions_[message.data.id];
  console.assert(session);

  if (message.command == 'close') {
    delete this.sessions_[session.id_];
    if (session.onClosedCallback_ != undefined) {
      session.onClosedCallback_(session);
    }
  } else if (message.command == 'data') {
    if (session.onDataCallback_ != undefined) {
      session.onDataCallback_(session, message.data.data);
    } else {
      console.log(message.data.data.valueOf());
    }
  }

};
