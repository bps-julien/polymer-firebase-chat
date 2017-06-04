"use strict";

const functions = require('firebase-functions');
const firebase = require('firebase-admin');
const Badwords = require('bad-words');
const capitalizeSentence = require('capitalize-sentence');
const gcs = require('@google-cloud/storage')();
const vision = require('@google-cloud/vision')();

const badWordsFilter = new Badwords();

firebase.initializeApp(functions.config().firebase);

exports.moderator = functions.database.ref('/messages/{messageId}').onWrite(event => {
  const message = event.data.val();
  if (message && !message.sanitized) {
    const moderatedMessage = moderateMessage(message.text);
    return event.data.adminRef.update({
      text: moderatedMessage,
      sanitized: true,
      moderated: message.text !== moderatedMessage
    });
  }
});

function moderateMessage(message) {
  if (isShouting(message)) {
    message = stopShouting(message);
  }
  if (containsSwearwords(message)) {
    message = moderateSwearwords(message);
  }
  return message;
}

function containsSwearwords(message) {
  return message !== badWordsFilter.clean(message);
}

function moderateSwearwords(message) {
  return badWordsFilter.clean(message);
}

function isShouting(message) {
  return message.replace(/[^A-Z]/g, '').length > message.length / 2 || message.replace(/[^!]/g, '').length >= 3;
}

function stopShouting(message) {
  return capitalizeSentence(message.toLowerCase()).replace(/!+/g, '.');
}

exports.blurOffensiveImages = functions.storage.object().onChange(event => {
  const object = event.data;
  const file = gcs.bucket(object.bucket).file(object.name);
  if (!object.contentType.startsWith('image/') && object.resourceState === 'not_exists') {
    return;
  }
  return vision.detectSafeSearch(file).then(data => {
    const safeSearch = data[0];
    if (!safeSearch.adult && !safeSearch.violence) {
      return firebase.database().ref('messages').child(object.metadata.key).set({
        key: object.name,
        type: 'image',
        url: object.mediaLink,
        metadata: object.metadata,
        timestamp: firebase.database.ServerValue.TIMESTAMP,
        user: {
          name: object.metadata.name,
          uid: object.metadata.uid,
          photoURL: object.metadata.photoURL
        }
      });
    }
    else return;
  });
});

function blurImage(filePath, bucketName, metadata) {
  const filePathSplit = filePath.split('/');
  filePathSplit.pop();
  const fileDir = filePathSplit.join('/');
  const tempLocalDir = `${LOCAL_TMP_FOLDER}${fileDir}`;
  const tempLocalFile = `${LOCAL_TMP_FOLDER}${filePath}`;
  const bucket = gcs.bucket(bucketName);
  return mkdirp(tempLocalDir).then(() => {
    return bucket.file(filePath).download({
      destination: tempLocalFile
    });
  }).then(() => {
    return exec(`convert ${tempLocalFile} -channel RGBA -blur 0x8 ${tempLocalFile}`);
  }).then(() => {
    return bucket.upload(tempLocalFile, {
      destination: filePath,
      metadata: {
        metadata: metadata
      }
    });
  })
  .then(v => console.log(v));
}