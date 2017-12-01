
const debounce = require('lodash.debounce')
const flatten = require('lodash.flatten')
const memoize = require('lodash.memoize')
const anymatch = require('anymatch')
const LevelUtil = require('./util-level')
const {debug, veryDebug, lock} = require('./util')

// exported api
// =

exports.loadArchives = async function (db, needsRebuild) {
  debug('Indexer.loadArchives, needsRebuild=' + needsRebuild)
  var promises = []
  await LevelUtil.each(db._indexMetaLevel, indexMeta => {
    debug('loading archive', indexMeta.url, indexMeta.localPath)
    // load the archive
    const archive = new (db.DatArchive)(indexMeta.url, {localPath: indexMeta.localPath})
    archive.isWritable = indexMeta.isWritable
    db._archives[archive.url] = archive

    // process the archive
    promises.push(
      indexArchive(db, archive, needsRebuild)
        .then(() => exports.watchArchive(db, archive))
        .catch(e => onFailInitialIndex(e, db, archive))
    )
  })
  await Promise.all(promises)
  debug('Indexer.loadArchives done')
}

exports.addArchive = async function (db, archive) {
  veryDebug('Indexer.addArchive', archive.url)
  // store entry in the meta db
  var info = await archive.getInfo()
  archive.isWritable = info.isOwner
  await db._indexMetaLevel.put(archive.url, {
    url: archive.url,
    version: 0,
    isWritable: archive.isWritable,
    localPath: archive._localPath
  })
  // process the archive
  await indexArchive(db, archive)
    .then(() => exports.watchArchive(db, archive))
    .catch(e => onFailInitialIndex(e, db, archive))
}

exports.removeArchive = async function (db, archive) {
  veryDebug('Indexer.removeArchive', archive.url)
  await unindexArchive(db, archive)
  exports.unwatchArchive(db, archive)
}

exports.watchArchive = async function (db, archive) {
  veryDebug('Indexer.watchArchive', archive.url)
  if (archive.fileEvents) {
    console.error('watchArchive() called on archive that already is being watched', archive.url)
    return
  }
  if (archive._loadPromise) {
    // HACK node-dat-archive fix
    // Because of a weird API difference btwn node-dat-archive and beaker's DatArchive...
    // ...the event-stream methods need await _loadPromise
    // -prf
    await archive._loadPromise
  }
  archive.fileEvents = archive.createFileActivityStream(db._tableFilePatterns)
  // autodownload all changes to the watched files
  //
  function download(path) {
    console.log('Jim downloading 2', archive.url, path)
    archive.download(path)
      .catch(err => {
        console.error('Jim error 1', err)
        db.emit('source-error', archive.url, err)
      })
  }
  const debouncedDownload = debounce(download, 1000)
  const memoizedDownload = memoize(debouncedDownload)
  archive.fileEvents.addEventListener( 'invalidated', ({path}) => {
    // console.log('Jim downloading 1', archive.url, path)
    memoizedDownload(path)
  })
  // autoindex on changes
  // TODO debounce!!!!
  archive.fileEvents.addEventListener('changed', ({path}) => {
    indexArchive(db, archive)
      .catch(err => {
        // console.error('Jim error 2', err)
        db.emit('source-error', archive.url, err)
      })
  })
}

exports.unwatchArchive = function (db, archive) {
  veryDebug('unwatching', archive.url)
  if (archive.fileEvents) {
    archive.fileEvents.close()
    archive.fileEvents = null
  }
}

exports.resetOutdatedIndexes = async function (db, neededRebuilds) {
  if (neededRebuilds.length === 0) {
    return false
  }
  debug(`Indexer.resetOutdatedIndexes need to rebuid ${neededRebuilds.length} tables`)
  veryDebug('Indexer.resetOutdatedIndexes tablesToRebuild', neededRebuilds)

  // clear tables
  // TODO go per-table
  const tables = db.tables
  for (let i = 0; i < tables.length; i++) {
    let table = tables[i]
    veryDebug('clearing', table.name)
    // clear indexed data
    await LevelUtil.clear(table.level)
  }

  // reset meta records
  var promises = []
  await LevelUtil.each(db._indexMetaLevel, indexMeta => {
    indexMeta.version = 0
    promises.push(db._indexMetaLevel.put(indexMeta.url, indexMeta))
  })
  await Promise.all(promises)

  return true
}

// figure how what changes need to be processed
// then update the indexes
async function indexArchive (db, archive, needsRebuild) {
  debug('Indexer.indexArchive', archive.url, {needsRebuild})
  var release = await lock(`index:${archive.url}`)
  try {
    // sanity check
    if (!db.isOpen && !db.isBeingOpened) {
      return
    }
    if (!db.level) {
      return console.log('indexArchive called on corrupted db')
    }

    // fetch the current state of the archive's index
    var [indexMeta, archiveMeta] = await Promise.all([
      db._indexMetaLevel.get(archive.url).catch(e => null),
      archive.getInfo()
    ])
    indexMeta = indexMeta || {version: 0}

    // has this version of the archive been processed?
    if (indexMeta && indexMeta.version >= archiveMeta.version) {
      debug('Indexer.indexArchive no index needed for', archive.url)
      return // yes, stop
    }
    debug('Indexer.indexArchive', archive.url, 'start', indexMeta.version, 'end', archiveMeta.version)

    // find and apply all changes which haven't yet been processed
    var updates = await scanArchiveHistoryForUpdates(db, archive, {
      start: indexMeta.version + 1,
      end: archiveMeta.version + 1
    })
    var results = await applyUpdates(db, archive, archiveMeta, updates)
    debug('Indexer.indexArchive applied', results.length, 'updates from', archive.url)

    // update meta
    await LevelUtil.update(db._indexMetaLevel, archive.url, {
      url: archive.url,
      version: archiveMeta.version // record the version we've indexed
    })

    // emit
    var updatedTables = new Set(results)
    for (let tableName of updatedTables) {
      if (!tableName) continue
      db[tableName].emit('index-updated', archive, archiveMeta.version)
    }
    db.emit('indexes-updated', archive, archiveMeta.version)
  } finally {
    release()
  }
}
exports.indexArchive = indexArchive

// delete all records generated from the archive
async function unindexArchive (db, archive) {
  var release = await lock(`index:${archive.url}`)
  try {
    // find any relevant records and delete them from the indexes
    var recordMatches = await scanArchiveForRecords(db, archive)
    await Promise.all(recordMatches.map(match => match.table.level.del(match.recordUrl)))
    await db._indexMetaLevel.del(archive.url)
  } finally {
    release()
  }
}
exports.unindexArchive = unindexArchive

// internal methods
// =

// helper for when the first indexArchive() fails
// emit an error, and (if it's a timeout) keep looking for the archive
async function onFailInitialIndex (e, db, archive) {
  if (e.name === 'TimeoutError') {
    debug('Indexer.onFailInitialIndex starting retry loop', archive.url)
    db.emit('source-missing', archive.url)
    while (true) {
      veryDebug('Indexer.onFailInitialIndex attempting load', archive.url)
      // try again every 30 seconds
      await new Promise(resolve => setTimeout(resolve, 30e3))
      // still a source?
      if (!db.isOpen || !(archive.url in db._archives)) {
        return
      }
      // re-attempt the index
      try {
        await indexArchive(db, archive)
        veryDebug('Indexer.onFailInitialIndex successfully loaded', archive.url)
        break // made it!
      } catch (e) {
        // abort if we get a non-timeout error
        if (e.name !== 'TimeoutError') {
          veryDebug('Indexer.onFailInitialIndex failed attempt, aborting', archive.url, e)
          return
        }
      }
    }
    // success
    db.emit('source-found', archive.url)
    try {
      exports.watchArchive(db, archive)
    } catch (err) {
      // console.error('Jim catch 1', err)
      throw err
    }
  } else {
    db.emit('source-error', archive.url, e)
  }
}

// look through the given history slice
// match against the tables' path patterns
// return back the *latest* change to each matching changed record
async function scanArchiveHistoryForUpdates (db, archive, {start, end}) {
  var history = await archive.history({start, end})
  var updates = {}
  history.forEach(update => {
    if (anymatch(db._tableFilePatterns, update.path)) {
      updates[update.path] = update
    }
  })
  return updates
}

// look through the archive for any files that generate records
async function scanArchiveForRecords (db, archive) {
  var recordFiles = await Promise.all(db.tables.map(table => {
    return table.listRecordFiles(archive)
  }))
  return flatten(recordFiles)
}

// iterate the updates and apply them to the indexes
async function applyUpdates (db, archive, archiveMeta, updates) {
  return Promise.all(Object.keys(updates).map(async path => {
    var update = updates[path]
    if (update.type === 'del') {
      return unindexFile(db, archive, update.path)
    } else {
      return readAndIndexFile(db, archive, archiveMeta, update.path)
    }
  }))
}

// read the file, find the matching table, validate, then store
async function readAndIndexFile (db, archive, archiveMeta, filepath) {
  const tables = db.tables
  const fileUrl = archive.url + filepath
  try {
    // read file
    var record = JSON.parse(await archive.readFile(filepath))

    // index on the first matching table
    for (var i = 0; i < tables.length; i++) {
      let table = tables[i]
      if (table.isRecordFile(filepath)) {
        // validate
        let isValid = !table.schema.validator || table.schema.validator(record)
        if (isValid) {
          // run preprocessor
          if (table.schema.preprocess) {
            let newRecord = table.schema.preprocess(record)
            if (newRecord) record = newRecord
          }
          // save
          await table.level.put(fileUrl, {
            url: fileUrl,
            origin: archive.url,
            indexedAt: Date.now(),
            record
          })
        } else {
          // delete
          await table.level.del(fileUrl)
        }
        return table.name
      }
    }
  } catch (e) {
    // console.log('Failed to index', fileUrl, e)
    db.emit('index-error', fileUrl, e)
  }
  return false
}

async function unindexFile (db, archive, filepath) {
  const tables = db.tables
  const fileUrl = archive.url + filepath
  try {
    // unindex on the first matching table
    for (var i = 0; i < tables.length; i++) {
      let table = tables[i]
      if (table.isRecordFile(filepath)) {
        await table.level.del(fileUrl)
        return table.name
      }
    }
  } catch (e) {
    console.log('Failed to unindex', fileUrl, e)
  }
  return false
}
