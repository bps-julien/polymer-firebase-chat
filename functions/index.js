"use strict";

const functions = require('firebase-functions');
const firebase = require('firebase-admin');
const Badwords = require('bad-words');
const capitalizeSentence = require('capitalize-sentence');
const gcs = require('@google-cloud/storage')({ keyFilename: 'polyfire-chat.json' });
const vision = require('@google-cloud/vision')();

const badWordsFilter = new Badwords();

firebase.initializeApp(functions.config().firebase);

exports.moderator = functions.database.ref('/messages/{messageId}').onWrite(event => {
  const message = event.data.val();
  if (message && !message.sanitized) {
    if(message.type === "text"){
      const moderatedMessage = moderateMessage(message.text);
      return event.data.adminRef.update({
        text: moderatedMessage,
        sanitized: true,
        moderated: message.text !== moderatedMessage
      }).then(_ => {
        return sendNotification(message, moderatedMessage.length <= 100 ? moderatedMessage : moderatedMessage.substring(0, 97) + '...');
      });
    }
    else if(message.type === "image") return sendNotification(message, message.url);
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

exports.filterImages = functions.storage.object().onChange(event => {
  const object = event.data;
  const file = gcs.bucket(object.bucket).file(object.name);
  if (!object.contentType.startsWith('image/') && object.resourceState === 'not_exists') {
    return;
  }
  return vision.detectSafeSearch(file).then(data => {
    const safeSearch = data[0];
    if (!safeSearch.adult && !safeSearch.violence) {
      return file.getSignedUrl({
        action: 'read',
        expires: '01-01-2100'
      }).then(signedUrls => {
        return firebase.database().ref('messages').child(object.metadata.key).set({
          key: object.name,
          type: 'image',
          url: signedUrls[0],
          timestamp: firebase.database.ServerValue.TIMESTAMP,
          user: {
            name: object.metadata.name,
            uid: object.metadata.uid,
            photoURL: object.metadata.photoURL
          }
        });
      });
    }
    else{ 
      return firebase.database().ref('messages').child(object.metadata.key).set({
        type: 'error',
        text: 'This image has been removed.',
        timestamp: firebase.database.ServerValue.TIMESTAMP,
        user: {
          name: object.metadata.name,
          uid: object.metadata.uid,
          photoURL: object.metadata.photoURL
        }
      });
    }
  });
});

function sendNotification(data, content) {
  const payload = {
    notification: {
      title: `${data.user.name} posted`,
      body: content,
      icon: data.user.photoURL || '/images/profile_placeholder.png',
      click_action: `https://${functions.config().firebase.authDomain}`
    }
  };

  return firebase.database().ref('fcmTokens').once('value').then(allTokens => {
    if (allTokens.exists()) {
      const tokenObjects = allTokens.val();
      let tokens = Object.keys(tokenObjects);
      let tokensToUse = [];
      tokens.map(token => tokenObjects[token] !== data.user.uid && tokensToUse.push(token));
      return firebase.messaging().sendToDevice(tokensToUse, payload).then(response => {
        const tokensToRemove = [];
        response.results.forEach((result, index) => {
          const error = result.error;
          if (error) {
            if (error.code === 'messaging/invalid-registration-token' ||
                error.code === 'messaging/registration-token-not-registered') {
              tokensToRemove.push(allTokens.ref.child(tokensToUse[index]).remove());
            }
          }
        });
        return Promise.all(tokensToRemove);
      });
    }
  });
}