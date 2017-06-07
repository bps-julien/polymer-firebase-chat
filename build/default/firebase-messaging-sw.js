importScripts('/__/firebase/4.1.1/firebase-app.js');
importScripts('/__/firebase/4.1.1/firebase-messaging.js');
importScripts('/__/firebase/init.js');

const messaging = firebase.messaging();

messaging.setBackgroundMessageHandler(payload => {
  const notificationTitle = payload.notification.title;
  const notificationOptions = {
    icon: payload.notification.icon
  };

  return self.registration.showNotification(notificationTitle, notificationOptions);
});