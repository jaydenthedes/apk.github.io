// Copyright 2014 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
//
// HTML5 filesystem code.


/** @const
 *
 * The total number of callbacks we need to wait for before HTML5 FS
 * initialization is done, which are:
 *  1) Promise completion of systemDirectoriesReady.
 *  2) handleAppPluginReady_.
 *
 * */
var _FS_INIT_CALLBACK_COUNT = 2;



/**
 * @constructor
 *
 * Sets up a component to handle fileSystem message from the runtime.
 *
 * @param plugin Plugin instance.
 */
function FileSystemManager(plugin, on_initialized_callback) {
  /** @private */
  this.plugin_ = plugin;

  /** @private */
  this.callbacks_ = [];

  /** @private */
  this.fileSystemInitCallbackCount_ = 0;

  /** @private */
  this.onInitializedCallback_ = on_initialized_callback;

  /** @private */
  this.retainedExternalFileSystemKey_ = 'retainedExternalFileSystemKey';

  /** @private */
  this.prefetchedMetadata_ = [];

  /** @private */
  this.externalFiles_ = null;

  /** @private */
  this.mountedExternalFilesKey_ = 'mountedExternalFiles';

  var self = this;

  plugin.addMessageListener('jsFileSystem', function(message) {
    self.handleMessage_(message);
  });

  if (document.readyState == 'loading') {
    // Start prefetching FS after DOMContentLoaded is fired so that plugin
    // initialization such as embedding arc.nexe starts earlier.
    document.addEventListener('DOMContentLoaded',
                              this.prefetchFileSystemMetadata_.bind(this));
  } else {
    // For tests the page is entirely loaded by the time we initialize
    // the filesystem, so if that is the case, prefetch on creation.
    this.prefetchFileSystemMetadata_();
  }

  plugin.addAppPluginReadyCallback(function() {
    self.postFileSystemReadyMessageIfNeeded();
  });
}


/** @private */
FileSystemManager.prototype.prefetchFileMetadata_ = function(fs) {
  var files = [
    '/data/data/com.android.settings/files/wallpaper',
    '/data/local.prop',
    '/data/security/mac_permissions.xml',
    '/data/system/accounts.db',
    '/data/system/appops.xml',
    '/data/system/appops.xml.bak',
    '/data/system/called_pre_boots.dat',
    '/data/system/devices/idc/PPAPI_Keyboard.idc',
    '/data/system/devices/keychars/PPAPI_Keyboard.kcm',
    '/data/system/devices/keylayout/Virtual.kl',
    '/data/system/display_settings.xml',
    '/data/system/display_settings.xml.bak',
    '/data/system/inputmethod/subtypes.xml',
    '/data/system/inputmethod/subtypes.xml.bak',
    '/data/system/notification_policy.xml',
    '/data/system/notification_policy.xml.bak',
    '/data/system/packages-backup.xml',
    '/data/system/packages-compat.xml',
    '/data/system/packages-compat.xml.bak',
    '/data/system/packages-stopped-backup.xml',
    '/data/system/packages-stopped.xml',
    '/data/system/packages.list',
    '/data/system/packages.xml',
    '/data/system/registered_services/android.accounts.AccountAuthenticator.xml',
    '/data/system/registered_services/android.accounts.AccountAuthenticator.xml.bak',
    '/data/system/registered_services/android.content.SyncAdapter.xml',
    '/data/system/sync/accounts.xml',
    '/data/system/sync/accounts.xml.bak',
    '/data/system/sync/pending.bin',
    '/data/system/sync/pending.xml',
    '/data/system/sync/pending.xml.bak',
    '/data/system/sync/stats.bin',
    '/data/system/sync/stats.bin.bak',
    '/data/system/sync/status.bin',
    '/data/system/sync/status.bin.bak',
    '/data/system/syncmanager.db',
    '/data/system/urigrants.xml',
    '/data/system/urigrants.xml.bak',
    '/data/system/usagestats/usage-history.xml',
    '/data/system/users/0.xml',
    '/data/system/users/0.xml.bak',
    '/data/system/users/0/accounts.db',
    '/data/system/users/0/accounts.db-journal',
    '/data/system/users/0/accounts.db-wal',
    '/data/system/users/0/package-restrictions-backup.xml',
    '/data/system/users/0/package-restrictions.xml',
    '/data/system/users/0/wallpaper',
    '/data/system/users/0/wallpaper_info.xml',
    '/data/system/users/0/wallpaper_info.xml.tmp',
    '/data/system/users/userlist.xml',
    '/data/system/users/userlist.xml.bak',
    '/data/system/wallpaper_info.xml'
  ];

  var self = this;
  var onGetMetadata = function(entry, metadata) {
    var result = { fullPath: entry.fullPath, exists: true,
                   isFile: entry.isFile,
                   // Milliseconds since Unix epoch. Use string since the
                   // valid mtime in milliseconds as of today is more than
                   // INT_MAX. The JSON reader and base::Value class in
                   // Chromium base do not support 64bit integer.
                   mtime_ms: String(metadata.modificationTime.getTime()),
                   // The same as above. To support >2GB files, use string.
                   size: String(metadata.size) };
    self.prefetchedMetadata_.push(result);
  };
  var onGetFail = function(filename) {
    // TODO(crbug.com/285588): This path is also taken when the file name is
    // actually a directory. In that case, we should not update the
    // |prefetchedMetadata_| array.
    var result = { fullPath: filename, exists: false };
    self.prefetchedMetadata_.push(result);
  };
  var promises = files.map(function(filename) {
    var fileEntry;
    return PromiseWrap.getFile(
        fs.root,
        filename,
        { create: false }).then(function(entry) {
      fileEntry = entry;
      return PromiseWrap.getMetadata(entry);
    }).then(function(metadata) {
      onGetMetadata(fileEntry, metadata);
    }, function(error) {
      onGetFail(filename);
    });
  });

  var allDone = Promise.all(promises);
  allDone.catch(function(err) {
    // Should not come here usually.
    console.error(err);
  });
  return allDone;
};


/** @private */
FileSystemManager.prototype.prefetchFileSystemMetadata_ =
    function(command, data) {
  /** @const */
  var FS_REQUEST_FS = 'ARC HTML5 FS: Request FileSystem';
  /** @const */
  var FS_PREFETCH = 'ARC HTML5 FS: prefetchFileMetadata_';

  console.time(FS_REQUEST_FS);
  // Call fs.root.getFile() as soon as possible for faster plugin startup
  // (crbug.com/170265). Calling the method forces the storage manager to run
  // the initilization code in an asynchronous manner.

  /**
   * Holds the HTML5 FileSystem object.
   * @type {FileSystem|undefined}
   */
  var fs;
  var filesystemReadyPromise = PromiseWrap.requestFileSystem(PERSISTENT)
      .then(function(filesystem) {
        console.timeEnd(FS_REQUEST_FS);
        fs = filesystem;
      });

  var self = this;
  return filesystemReadyPromise.then(function() {
    return window['arc'].systemDirectoriesReady;
  }).then(function(systemDirectoryMetadata) {
    self.prefetchedMetadata_ = self.prefetchedMetadata_.concat(
        systemDirectoryMetadata);
    if (!self.postFileSystemReadyMessageIfNeeded()) {
      // Execute prefetchFileMetadata_ only when loading the main executable
      // is slow. postFileSystemReadyMessageIfNeeded is allowed to send the
      // 'ready' message without waiting for prefetchFileMetadata_ to finish.
      console.time(FS_PREFETCH);
      self.prefetchFileMetadata_(fs).then(function() {
        console.timeEnd(FS_PREFETCH);
      });
    }
  });
};


/**
 * @private
 *
 * Posts a message to plugin.
 */
FileSystemManager.prototype.postMessage_ = function(namespace, command, data) {
  var message = {
    namespace: namespace,
    command: command,
    data: data
  };
  this.plugin_.postMessage(message);
};


/**
 * @private
 *
 * Returns state of external file entries. This is done on demand. If state
 * was not loaded before then restores its state from local storage.
 */
FileSystemManager.prototype.getExternalFiles_ = function() {
  var self = this;
  if (this.externalFiles_)
    return this.externalFiles_;

  this.externalFiles_ = PromiseWrap.getLocalStorageValue(
      self.mountedExternalFilesKey_).then(function(itemsstr) {
    var externalFiles = JSON.parse(itemsstr);
    if (!externalFiles) {
      console.error('Error! Cannot restore external files.' +
                    ' Invalid value for ' + itemstr);
      return {};
    }
    return externalFiles;
  }, function(err) {
    // This is possible at first time.
    return {};
  });

  return this.externalFiles_;
};


/**
 * @private
 *
 * Saves state of external file entries.
 */
FileSystemManager.prototype.saveExternalFiles_ = function(externalFiles) {
  var obj = {};
  obj[this.mountedExternalFilesKey_] = JSON.stringify(externalFiles);
  chrome.storage.local.set(obj);
  this.externalFiles_ = Promise.resolve(externalFiles);
};


/**
 * @private
 *
 * Posts a message to plugin, then calls the callback function when the plugin
 * sends the reply message.
 */
FileSystemManager.prototype.postMessageAndReply_ =
    function(namespace, command, data) {
  var self = this;
  return new Promise(function(resolve, reject) {
    self.callbacks_.push(function(replyData) {
      resolve(replyData);
    });
    self.postMessage_(namespace, command,
                      {messageId: self.callbacks_.length - 1, info: data});
  });
};


/** @private */
FileSystemManager.prototype.updateExtDirButtonVisibility_ = function(visible) {
  document.getElementById('extdir-button').className =
      visible ? 'button' : 'hiddenbutton';
};


/** @private */
FileSystemManager.prototype.handleMessage_ = function(message) {
  // Call reply function if corresponding callback function is registerd.
  if (message.data.messageId != undefined &&
      message.data.messageId < this.callbacks_.length) {
    this.callbacks_[message.data.messageId](message.data);
    this.callbacks_[message.data.messageId] = null;
    return;
  }

  if (message.command == 'openExternalFile') {
    this.handleOpenExternalFileMessage_(message.data);
  } else if (message.command == 'openExternalDirectory') {
    this.handleOpenExternalDirectoryMessage_();
  } else if (message.command == 'requestFileFromFileHandler') {
    this.handleRequestFileFromFileHandler_();
  } else if (message.command == 'mountExternalFileCall') {
    this.handleMountExternalFile_(message.data);
  }
};


/** @private */
FileSystemManager.prototype.sendMountExtDirMessage_ =
    function(fileSystem, fullPath) {
  var data = {fileSystem: fileSystem, fullPath: fullPath,
               writable: true};
  this.postMessageAndReply_(
      'pluginFileSystemManager', 'mountExternalDirectory', data);
};


/** @private */
FileSystemManager.prototype.handleOpenExternalDirectoryMessage_ = function() {
  console.assert(this.plugin_.getMetadata().enableExternalDirectory);

  var self = this;
  PromiseWrap.getLocalStorageValue(
      self.retainedExternalFileSystemKey_).then(function(key) {
    return PromiseWrap.isFilesystemRestorable(key);
  }).then(function(key) {
    return PromiseWrap.restoreFilesystem(key);
  }).then(function(entry) {
    self.sendMountExtDirMessage_(entry.filesystem, entry.fullPath);
    self.updateExtDirButtonVisibility_(true);
  }, function(err) {
    // Reaching here is totally fine. The retained external directory may no
    // longer available or accessible. Just open dialog again to choose new
    // external directory.
    self.openAndMountExternalDirectory(
        false /* no need to reset external file handler*/);
  });
};


/**
 * @public
 *
 * Notifies the plugin process that the HTML5 file system is set up.
 *
 * @return {boolean} true when pluginFileSystemManager/ready message is sent.
 */
FileSystemManager.prototype.postFileSystemReadyMessageIfNeeded =
    function() {
  this.fileSystemInitCallbackCount_++;
  console.log('File system initialization ' +
              this.fileSystemInitCallbackCount_ + '/' +
              _FS_INIT_CALLBACK_COUNT);
  if (this.fileSystemInitCallbackCount_ == _FS_INIT_CALLBACK_COUNT) {
    console.log('Sending ' + this.prefetchedMetadata_.length +
        ' file system cache entries to the plugin');
    this.postMessage_('pluginFileSystemManager', 'ready',
                      { value: this.prefetchedMetadata_ });
  } else if (this.fileSystemInitCallbackCount_ == _FS_INIT_CALLBACK_COUNT - 1) {
    // Now the browser process is likely idle. Show the app window.
    this.onInitializedCallback_();
  }
  return this.fileSystemInitCallbackCount_ == _FS_INIT_CALLBACK_COUNT;
};


/**
 * @public
 *
 * Opens directory chooser and mount it to /stroage/sdcard as external storage.
 *
 * @param needResetBeforeMount Resets the external file handler to initial
 * state.
 **/
FileSystemManager.prototype.openAndMountExternalDirectory = function(
    needResetBeforeMount) {
  if (!this.plugin_.getMetadata().enableExternalDirectory)
    return;

  var self = this;
  PromiseWrap.chooseEntry({type: 'openDirectory'}).then(function(entry) {
    if (needResetBeforeMount) {
      self.postMessage_('pluginFileSystemManager', 'resetExternalDirectory',
                        {});
    }

    self.sendMountExtDirMessage_(entry.filesystem, entry.fullPath);
    self.updateExtDirButtonVisibility_(true);

    // Retains chosen entry to be able to use next time launch.
    var obj = {};
    obj[self.retainedExternalFileSystemKey_] =
        chrome.fileSystem.retainEntry(entry);
    chrome.storage.local.set(obj, function() {});
  }, function(err) {
    if (err.message == 'User cancelled') {
      // If user cancels directory choosing do nothing,
      // TODO(crbug.com/317282): Need revisit UX for directory choosing and
      // reconfiguration.
      return;
    } else {
      throw err;
    }
  });
};


/**
 * @private
 *
 * Handles a "openExternalFile" command message.
 */
FileSystemManager.prototype.handleOpenExternalFileMessage_ = function(data) {
  var options = {
    type: data.type.valueOf()
  };

  if (data.type == 'openFile') {
    options.accepts = [{ mimeTypes: data.acceptTypes.valueOf() }];
  } else {
    options.suggestedName = data.suggestedName.valueOf();
  }

  var self = this;
  var chosenEntry = null;
  var retainKey = null;
  var isWritable = false;
  PromiseWrap.chooseEntry(options).then(function(entry) {
    chosenEntry = entry;

    // Succeeded choosing file with 'saveFile' means the passed file entry is
    // writable.
    isWritable = (data.type == 'saveFile');
    var replyData = { fileSystem: chosenEntry.filesystem,
                      fullPath: chosenEntry.fullPath,
                      writable: isWritable };
    retainKey = chrome.fileSystem.retainEntry(chosenEntry);
    return self.postMessageAndReply_(
        'pluginFileSystemManager', 'mountExternalFile', replyData);
  }).then(function(replyData) {
    var mountPoint = replyData.info.mountPoint;
    self.getExternalFiles_().then(function(externalFiles) {
      externalFiles[mountPoint] = {retainKey: retainKey, writable: isWritable};
      self.saveExternalFiles_(externalFiles);
    });

    self.postMessage_(
        data.requester, 'openExternalFileResponse',
        { result: true, path: mountPoint });
  }, function(err) {
    if (err.message != 'User cancelled') {
      console.error(err);
    }
    self.postMessage_(
        data.requester, 'openExternalFileResponse', { result: false });
  });
};


/**
 * @private
 *
 * Mount file entry passed from file handlers and reply to
 * "requestFileFromFileHandler" message.
 */
FileSystemManager.prototype.handleRequestFileFromFileHandler_ = function() {
  // Check if chrome.app.window.current().launchArgs.items exists.
  var items = window['arc'].launchArgs.items;
  if (!items || !items.length) {
    return;
  }

  var entry = items[0].entry;
  var mimeType = items[0].type;

  var self = this;
  var mountData = { fileSystem: entry.filesystem,
                    fullPath: entry.fullPath,
                    writable: true };
  self.postMessageAndReply_('pluginFileSystemManager',
                            'mountExternalFile',
                            mountData).then(function(data) {
    self.postMessage_(
        'androidFileHandler', 'requestFileFromFileHandlerResponse',
        {result: true, path: data.info.mountPoint, mimeType: mimeType});
  }, function(err) {
    console.error(err);
    self.postMessage_('androidFileHandler',
                      'requestFileFromFileHandlerResponse',
                      {result: false });
  });
};


/**
 * @private
 *
 * Handles a "mountExternalFile" command message.
 */
FileSystemManager.prototype.handleMountExternalFile_ = function(data) {
  var self = this;
  var namespace = data.requester;
  var command = 'rpcReturn';
  var resdata = {requestId: data.requestId, result: false};
  var entryinfo;

  self.getExternalFiles_().then(function(externalFiles) {
    entryinfo = externalFiles[data.path];
    if (!entryinfo || !entryinfo.retainKey) {
      resdata.error = 'Does not exist';
      self.postMessage_(namespace, command, resdata);
      return;
    }
    return PromiseWrap.isFilesystemRestorable(entryinfo.retainKey);
  }).then(function(key) {
    return PromiseWrap.restoreFilesystem(key);
  }).then(function(entry) {
    var infodata = {};
    infodata.fileSystem = entry.filesystem;
    infodata.fullPath = entry.fullPath;
    infodata.writable = entryinfo.writable;
    resdata.messageId = 0;
    resdata.result = true;
    resdata.info = infodata;
    self.postMessage_(namespace, command, resdata);
  }, function(err) {
    // Reaching here is totally fine. The retained file may no
    // longer available or accessible.
    console.warn('Warning! Data to restore entry for path ' +
        data.path + '(' + entryinfo.retainKey + ') no longer exists');
    resdata.error = 'Is not restorable';
    self.postMessage_(namespace, command, resdata);
  });
};
