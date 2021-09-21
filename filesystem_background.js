// Copyright 2014 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// Returns the parent directory path of |path|.  If |path| is the root path,
// returns |path| itself.
function getParentPath(path) {
  if (path === '/')
    return path;

  path = path.replace(/\/+$/, '');  // Strip trailing slashes.
  var slash_index = path.lastIndexOf('/');
  if (slash_index === 0)
    return '/';
  if (slash_index < 0)
    return '';
  return path.slice(0, slash_index);
}


function joinPath(parent, path) {
  return (parent + '/' + path).replace(/\/+/g, '/');
}


// Returns directory metadata to pass to the plugin.
function createDirectoryMetadata(fullPath) {
  // Use string for mtime and size. See prefetchFileMetadata_
  // for more details. For directories, we do not have to
  // provide mtime as posix_translation does not use it at all.
  return {fullPath: fullPath, exists: true, isFile: false,
    mtime_ms: '0', size: '4096'};
}


// Returns missing entry metadata to pass to the plugin.
function createMissingEntryMetadata(fullPath) {
  return {fullPath: fullPath, exists: false};
}


// Creates directories for specified paths and their parents.  Returns a
// promise to be resolved by an array of the directory metadata.
function createDirectories(root, paths) {
  var promises = [];
  var promise_by_path = {};

  function createDirectory(path) {
    var parent = getParentPath(path);
    if (parent === path)
      return Promise.resolve();
    if (path in promise_by_path)
      return promise_by_path[path];

    var promise = createDirectory(parent).then(function() {
      return PromiseWrap.getDirectory(root, path, {create: true});
    }).then(handleSuccess, handleFailure.bind(null, path));
    promise_by_path[path] = promise;
    promises.push(promise);
    return promise;
  }

  function handleSuccess(entry) {
    return createDirectoryMetadata(entry.fullPath);
  }

  function handleFailure(path) {
    return createMissingEntryMetadata(joinPath(root.fullPath, path));
  }

  for (var i = 0; i < paths.length; ++i)
    createDirectory(paths[i]);
  return Promise.all(promises);
}


function createSystemDirectories() {
  // TODO(crbug.com/431663): Collect UMA stats to count how frequent does
  // this function creates the system directories.

  var root = PromiseWrap.requestFileSystemRoot(PERSISTENT);
  var packageName = arcMetadata.get().packageName;
  var directories = [
    'cache',
    'data/app',
    'data/app-lib',
    'data/dalvik-cache',
    'data/data/org.chromium.arc/lib',
    'data/local/tmp',
    'data/misc/keystore',
    'data/system/dropbox',
    'data/system/ifw',
    'data/system/inputmethod',
    'data/system/netstats',
    'data/system/procstats',
    'data/system/sync',
    'data/system/usagestats',
    'data/system/users/0',
    'data/user',
    'storage/sdcard',
    'data/app-lib/arc',
    'data/app-private',
    // This is for making stat in posix_translation::RedirectHandler::symlink
    // and rmdir in plugin/file_system_manager.cc faster.
    'data/data/' + packageName + '/lib',
    'data/system/registered_services',
    'storage/sdcard/Android/data/' + packageName,
    'storage/sdcard/Android/data/org.chromium.arc/'
  ];
  var marker_path = '.system_directories_ready';
  var marker_string = directories.join('\n');

  var marker =
      applyPromise([root, marker_path, {create: false}], PromiseWrap.getFile)
      .then(PromiseWrap.file)
      .then(PromiseWrap.readBlobAsText)
      .then(function(content) {
        if (content === marker_string) {
          var directory_metadata = [];
          for (var i = 0; i < directories.length; ++i) {
            directory_metadata.push(createDirectoryMetadata(
                joinPath('/', directories[i])));
          }
          return directory_metadata;
        }
        console.log('The set of system directories is changed. Recreating.');
        return Promise.reject();
      });
  return marker.catch(function(e) {
    var created = applyPromise([root, directories], createDirectories);

    // Add |created| to |marker_file| dependency to ensure failure in |created|
    // is propagated to the following operations.
    var marker_file = created.then(function() {
      return applyPromise([root, marker_path, {create: true}],
                          PromiseWrap.getFile);
    });
    var writer = marker_file.then(PromiseWrap.createWriter);
    writer = applyPromise([writer, 0], PromiseWrap.truncate);
    var marked = applyPromise([writer, new Blob([marker_string])],
                              PromiseWrap.write);
    marked.catch(function() {
      console.error('Failed to make marker file for' +
          ' system directory creation.');
    });
    return created;
  });
}
