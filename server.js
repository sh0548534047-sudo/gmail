import express from 'express';

const app = express();

app.use(express.json({
  limit: '1mb'
}));

const PORT = process.env.PORT || 10000;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const RENDER_SECRET = process.env.RENDER_SECRET;
const YEMOT_SECRET = process.env.YEMOT_SECRET;

/*
 * גרסת בסיס.
 *
 * בשרת אמיתי מומלץ להחליף Map במסד נתונים כמו Redis,
 * כדי שהמצב לא יימחק בהפעלה מחדש של Render.
 */
const sessions = new Map();

app.get('/', (req, res) => {
  res.send('Gmail Yemot gateway is running');
});


app.post('/yemot', async (req, res) => {
  try {
    if (!isYemotRequestAllowed(req)) {
      return res.status(403).send('ERROR');
    }

    const input = normalizeInput(req.body);
    const session = getSession(input.apiCallId);

    const response = await handleAction(input, session);

    saveSession(input.apiCallId, session);

    res
      .type('text/plain; charset=utf-8')
      .send(response);

  } catch (error) {
    console.error(error);

    res
      .type('text/plain; charset=utf-8')
      .send(
        say('אירעה שגיאה במערכת. נסה שוב מאוחר יותר.') +
        '&' +
        goBack()
      );
  }
});


/**
 * בדיקה באמצעות POST JSON.
 */
app.post('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'gmail-yemot-render'
  });
});


app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});


/* =========================================================
   Main flow
========================================================= */

async function handleAction(input, session) {
  const action = input.action || '';

  /*
   * שלוחות שאתה מגדיר בימות:
   *
   * 1 = שמיעת מיילים
   * 2 = שליחת מייל
   *
   * בתוך 1:
   * 1 all
   * 2 inbox
   * 3 sent
   * 4 unread
   * 5 drafts
   * 6 trash
   * 7 spam
   * 8 search
   * 9 labels
   */
  if (action === 'main') {
    return mainMenu();
  }

  if (action === 'listen') {
    return listenMenu();
  }

  if (action === 'send_mail') {
    session.flow = 'send_mail';
    session.step = 'select_sender';

    return await sendMailStart(session);
  }

  if (action === 'inbox' ||
      action === 'all' ||
      action === 'sent' ||
      action === 'unread' ||
      action === 'drafts' ||
      action === 'trash' ||
      action === 'spam') {
    return await openMessageList(action, session);
  }

  if (action === 'search') {
    session.flow = 'search';
    session.step = 'search_text';

    return readHebrew(
      'הקלד את מילת החיפוש',
      buildCallback('search_text')
    );
  }

  if (action === 'labels') {
    return await labelsMenu(session);
  }

  if (action === 'label') {
    if (!input.label) {
      return say('לא נבחרה תווית') + '&' + listenMenu();
    }

    return await openMessageList(
      'label',
      session,
      {
        label: input.label
      }
    );
  }

  if (action === 'read_message') {
    return await showCurrentMessage(session);
  }

  if (action === 'next_message') {
    return await nextMessage(session);
  }

  if (action === 'previous_message') {
    return await previousMessage(session);
  }

  if (action === 'reply') {
    session.flow = 'reply';
    session.step = 'reply_text';

    return readHebrew(
      'הקלד את תוכן התגובה',
      buildCallback('reply_text')
    );
  }

  if (action === 'forward') {
    session.flow = 'forward';
    session.step = 'forward_recipient_mode';

    return recipientModeQuestion('forward_recipient_mode');
  }

  if (action === 'toggle_read') {
    return await toggleRead(session);
  }

  if (action === 'delete_message') {
    return await deleteCurrentMessage(session);
  }

  if (action === 'add_contact') {
    return await addContactInstruction(session);
  }

  if (action === 'blacklist') {
    session.step = 'blacklist_confirm';

    return say(
      'הוספת השולח לרשימת חסימת הצינתוקים. להמשך הקש 1.'
    ) + '&' + readDigits(
      'BLACKLIST_CONFIRM',
      1,
      1,
      buildCallback('blacklist_confirm')
    );
  }

  /*
   * שלב שליחת מייל
   */
  if (session.flow === 'send_mail') {
    return await handleSendFlow(input, session);
  }

  /*
   * שלב תגובה
   */
  if (session.flow === 'reply') {
    return await handleReplyFlow(input, session);
  }

  /*
   * שלב העברה
   */
  if (session.flow === 'forward') {
    return await handleForwardFlow(input, session);
  }

  /*
   * לחיצה מתוך תפריט מייל.
   */
  if (input.message_action) {
    return await handleMessageAction(input, session);
  }

  return mainMenu();
}


/* =========================================================
   Menus
========================================================= */

function mainMenu() {
  return [
    say('לשמיעת מיילים הקש 1. לשליחת מייל הקש 2.'),
    readDigits(
      'MAIN_CHOICE',
      1,
      1,
      callbackActions({
        '1': 'listen',
        '2': 'send_mail'
      })
    )
  ].join('&');
}


function listenMenu() {
  return [
    say(
      'לכל המיילים הקש 1. ' +
      'לדואר נכנס הקש 2. ' +
      'לדואר יוצא הקש 3. ' +
      'למיילים שלא נקראו הקש 4. ' +
      'לטיוטות הקש 5. ' +
      'לאשפה הקש 6. ' +
      'לספאם הקש 7. ' +
      'לחיפוש הקש 8. ' +
      'לתוויות הקש 9.'
    ),
    readDigits(
      'LIST_CHOICE',
      1,
      1,
      callbackActions({
        '1': 'all',
        '2': 'inbox',
        '3': 'sent',
        '4': 'unread',
        '5': 'drafts',
        '6': 'trash',
        '7': 'spam',
        '8': 'search',
        '9': 'labels'
      })
    )
  ].join('&');
}


function messageMenu() {
  return [
    readDigits(
      'MESSAGE_ACTION',
      1,
      1,
      callbackActions({
        '1': 'reply',
        '2': 'previous_message',
        '3': 'forward',
        '4': 'toggle_read',
        '5': 'unused',
        '6': 'attachments',
        '7': 'add_contact',
        '8': 'next_message',
        '9': 'blacklist',
        '0': 'delete_message'
      })
    )
  ].join('&');
}


function recipientModeQuestion(callback) {
  return [
    say(
      'לבחירת איש קשר הקש 1. ' +
      'להקלדת כתובת מייל הקש 2.'
    ),
    readDigits(
      'RECIPIENT_MODE',
      1,
      1,
      buildCallback(callback)
    )
  ].join('&');
}


/* =========================================================
   Message lists
========================================================= */

async function openMessageList(mode, session, extra = {}) {
  const result = await appsScript('list_messages', {
    mode,
    limit: 50,
    label: extra.label || '',
    query: extra.query || ''
  });

  if (!result.messages || result.messages.length === 0) {
    return say('לא נמצאו מיילים') + '&' + listenMenu();
  }

  session.mode = mode;
  session.messages = result.messages;
  session.index = 0;
  session.step = 'message';

  return await showCurrentMessage(session);
}


async function showCurrentMessage(session) {
  if (!session.messages || session.messages.length === 0) {
    return say('אין מיילים להצגה') + '&' + listenMenu();
  }

  if (
    session.index < 0 ||
    session.index >= session.messages.length
  ) {
    return say('אין הודעה נוספת') + '&' + messageMenu();
  }

  const summary = session.messages[session.index];

  const message = await appsScript('get_message', {
    message_id: summary.id
  });

  session.currentMessage = message;

  const spoken = formatMessageForSpeech(message);

  return [
    say(spoken),
    messageMenu()
  ].join('&');
}


async function nextMessage(session) {
  if (!session.messages) {
    return listenMenu();
  }

  if (session.index >= session.messages.length - 1) {
    return say('זו ההודעה האחרונה') + '&' + messageMenu();
  }

  session.index++;
  return await showCurrentMessage(session);
}


async function previousMessage(session) {
  if (!session.messages) {
    return listenMenu();
  }

  if (session.index <= 0) {
    return say('זו ההודעה הראשונה') + '&' + messageMenu();
  }

  session.index--;
  return await showCurrentMessage(session);
}


async function labelsMenu(session) {
  const result = await appsScript('get_labels', {});

  if (!result.labels || result.labels.length === 0) {
    return say('אין תוויות') + '&' + listenMenu();
  }

  session.labels = result.labels;

  const text = result.labels
    .map((label, index) => {
      return `${index + 1} ${label.name}`;
    })
    .join('. ');

  /*
   * לאחר בחירת מספר, ימות ישלח action=label_choice
   * עם label_index. במקרה זה נדרש להוסיף את הלוגיקה
   * handleLabelChoice כפי שמופיעה בהמשך.
   */
  session.step = 'label_choice';

  return [
    say(text),
    readDigits(
      'LABEL_INDEX',
      1,
      2,
      buildCallback('label_choice')
    )
  ].join('&');
}


/* =========================================================
   Send mail flow
========================================================= */

async function sendMailStart(session) {
  const profile = await appsScript('get_profile', {});

  session.senders = profile.senders || [];
  session.sender = null;
  session.to = [];
  session.cc = [];
  session.bcc = [];
  session.subject = '';
  session.body = '';

  if (session.senders.length === 1) {
    session.sender = session.senders[0];
    session.step = 'recipient_mode';

    return recipientModeQuestion('recipient_mode');
  }

  const text = session.senders
    .map((sender, index) => `${index + 1} ${sender}`)
    .join('. ');

  session.step = 'sender_choice';

  return [
    say(`מאיזו כתובת לשלוח? ${text}`),
    readDigits(
      'SENDER_INDEX',
      1,
      2,
      buildCallback('sender_choice')
    )
  ].join('&');
}


async function handleSendFlow(input, session) {
  if (session.step === 'sender_choice') {
    const index = Number(input.digits || input.value || 0) - 1;

    if (!session.senders[index]) {
      return say('בחירה לא חוקית') + '&' +
        readDigits(
          'SENDER_INDEX',
          1,
          2,
          buildCallback('sender_choice')
        );
    }

    session.sender = session.senders[index];
    session.step = 'recipient_mode';

    return recipientModeQuestion('recipient_mode');
  }

  if (session.step === 'recipient_mode') {
    const choice = String(input.digits || input.value || '');

    if (choice === '1') {
      session.step = 'contact_search';

      return readEnglish(
        'הקלד חלק משם איש הקשר',
        buildCallback('contact_search')
      );
    }

    if (choice === '2') {
      session.step = 'typed_recipient';

      return readEmail(
        'הקלד את כתובת המייל',
        buildCallback('typed_recipient')
      );
    }

    return say('בחירה לא חוקית') + '&' +
      recipientModeQuestion('recipient_mode');
  }

  if (session.step === 'contact_search') {
    const result = await appsScript('search_contacts', {
      query: input.text || input.value || ''
    });

    if (!result.contacts || result.contacts.length === 0) {
      return say('לא נמצאו אנשי קשר') + '&' +
        readEnglish(
          'הקלד חיפוש חדש',
          buildCallback('contact_search')
        );
    }

    session.contacts = result.contacts;
    session.step = 'contact_choice';

    const text = result.contacts
      .map((contact, index) => {
        return `${index + 1} ${contact.name} ${contact.email}`;
      })
      .join('. ');

    return [
      say(text),
      readDigits(
        'CONTACT_INDEX',
        1,
        2,
        buildCallback('contact_choice')
      )
    ].join('&');
  }

  if (session.step === 'contact_choice') {
    const index = Number(input.digits || input.value || 0) - 1;
    const contact = session.contacts?.[index];

    if (!contact) {
      return say('בחירה לא חוקית') + '&' +
        readDigits(
          'CONTACT_INDEX',
          1,
          2,
          buildCallback('contact_choice')
        );
    }

    session.to.push(contact.email);
    session.step = 'more_recipients';

    return moreRecipientsQuestion();
  }

  if (session.step === 'typed_recipient') {
    const email = String(input.text || input.value || '').trim();

    if (!isEmail(email)) {
      return say('כתובת המייל אינה תקינה') + '&' +
        readEmail(
          'הקלד כתובת מייל חדשה',
          buildCallback('typed_recipient')
        );
    }

    session.to.push(email);
    session.step = 'more_recipients';

    return moreRecipientsQuestion();
  }

  if (session.step === 'more_recipients') {
    const choice = String(input.digits || input.value || '');

    if (choice === '1') {
      session.step = 'additional_recipient_mode';
      return additionalRecipientModeQuestion();
    }

    if (choice === '2') {
      session.step = 'subject';
      return readHebrew(
        'הקלד את נושא ההודעה',
        buildCallback('subject')
      );
    }

    return moreRecipientsQuestion();
  }

  if (session.step === 'additional_recipient_mode') {
    const choice = String(input.digits || input.value || '');

    if (choice === '1') {
      session.recipientType = 'to';
    } else if (choice === '2') {
      session.recipientType = 'cc';
    } else if (choice === '3') {
      session.recipientType = 'bcc';
    } else if (choice === '4') {
      session.step = 'subject';

      return readHebrew(
        'הקלד את נושא ההודעה',
        buildCallback('subject')
      );
    } else {
      return additionalRecipientModeQuestion();
    }

    session.step = 'additional_recipient';
    return readEmail(
      'הקלד את כתובת המייל',
      buildCallback('additional_recipient')
    );
  }

  if (session.step === 'additional_recipient') {
    const email = String(input.text || input.value || '').trim();

    if (!isEmail(email)) {
      return say('כתובת המייל אינה תקינה') + '&' +
        readEmail(
          'הקלד כתובת מייל חדשה',
          buildCallback('additional_recipient')
        );
    }

    if (session.recipientType === 'cc') {
      session.cc.push(email);
    } else if (session.recipientType === 'bcc') {
      session.bcc.push(email);
    } else {
      session.to.push(email);
    }

    session.step = 'more_recipients';

    return moreRecipientsQuestion();
  }

  if (session.step === 'subject') {
    session.subject = String(input.text || input.value || '');
    session.step = 'body';

    return readHebrew(
      'הקלד את תוכן ההודעה',
      buildCallback('body')
    );
  }

  if (session.step === 'body') {
    session.body = String(input.text || input.value || '');

    const result = await appsScript('send_mail', {
      from: session.sender,
      to: session.to.join(','),
      cc: session.cc.join(','),
      bcc: session.bcc.join(','),
      subject: session.subject,
      body: session.body
    });

    session.flow = null;
    session.step = null;

    return say('המייל נשלח בהצלחה') + '&' + mainMenu();
  }

  return sendMailStart(session);
}


function moreRecipientsQuestion() {
  return [
    say(
      'להוספת נמען נוסף הקש 1. ' +
      'להמשך לנושא ההודעה הקש 2.'
    ),
    readDigits(
      'MORE_RECIPIENTS',
      1,
      1,
      buildCallback('more_recipients')
    )
  ].join('&');
}


function additionalRecipientModeQuestion() {
  return [
    say(
      'לנמען ראשי הקש 1. ' +
      'להעתק הקש 2. ' +
      'להעתק מוסתר הקש 3. ' +
      'לסיום הקש 4.'
    ),
    readDigits(
      'ADDITIONAL_RECIPIENT_MODE',
      1,
      1,
      buildCallback('additional_recipient_mode')
    )
  ].join('&');
}


/* =========================================================
   Reply flow
========================================================= */

async function handleReplyFlow(input, session) {
  if (session.step !== 'reply_text') {
    return messageMenu();
  }

  const body = String(input.text || input.value || '');

  if (!body) {
    return readHebrew(
      'לא התקבל תוכן. הקלד את תוכן התגובה',
      buildCallback('reply_text')
    );
  }

  await appsScript('reply', {
    message_id: session.currentMessage.id,
    body: body
  });

  session.flow = null;
  session.step = 'message';

  return say('התגובה נשלחה') + '&' + messageMenu();
}


/* =========================================================
   Forward flow
========================================================= */

async function handleForwardFlow(input, session) {
  if (session.step === 'forward_recipient_mode') {
    const choice = String(input.digits || input.value || '');

    if (choice === '1') {
      session.step = 'forward_contact_search';

      return readEnglish(
        'הקלד חלק משם איש הקשר',
        buildCallback('forward_contact_search')
      );
    }

    if (choice === '2') {
      session.step = 'forward_typed_recipient';

      return readEmail(
        'הקלד את כתובת המייל להעברה',
        buildCallback('forward_typed_recipient')
      );
    }

    return recipientModeQuestion('forward_recipient_mode');
  }

  if (session.step === 'forward_contact_search') {
    const result = await appsScript('search_contacts', {
      query: input.text || input.value || ''
    });

    if (!result.contacts || result.contacts.length === 0) {
      return say('לא נמצאו אנשי קשר') + '&' +
        readEnglish(
          'הקלד חיפוש חדש',
          buildCallback('forward_contact_search')
        );
    }

    session.contacts = result.contacts;
    session.step = 'forward_contact_choice';

    const text = result.contacts
      .map((contact, index) => {
        return `${index + 1} ${contact.name} ${contact.email}`;
      })
      .join('. ');

    return [
      say(text),
      readDigits(
        'FORWARD_CONTACT_INDEX',
        1,
        2,
        buildCallback('forward_contact_choice')
      )
    ].join('&');
  }

  if (session.step === 'forward_contact_choice') {
    const index = Number(input.digits || input.value || 0) - 1;
    const contact = session.contacts?.[index];

    if (!contact) {
      return say('בחירה לא חוקית') + '&' +
        messageMenu();
    }

    await appsScript('forward', {
      message_id: session.currentMessage.id,
      to: contact.email,
      note: ''
    });

    session.flow = null;
    session.step = 'message';

    return say('המייל הועבר בהצלחה') + '&' + messageMenu();
  }

  if (session.step === 'forward_typed_recipient') {
    const email = String(input.text || input.value || '').trim();

    if (!isEmail(email)) {
      return say('כתובת המייל אינה תקינה') + '&' +
        readEmail(
          'הקלד כתובת מייל חדשה',
          buildCallback('forward_typed_recipient')
        );
    }

    await appsScript('forward', {
      message_id: session.currentMessage.id,
      to: email,
      note: ''
    });

    session.flow = null;
    session.step = 'message';

    return say('המייל הועבר בהצלחה') + '&' + messageMenu();
  }

  return messageMenu();
}


/* =========================================================
   Message actions
========================================================= */

async function handleMessageAction(input, session) {
  const action = input.message_action;

  switch (action) {
    case 'reply':
      session.flow = 'reply';
      session.step = 'reply_text';

      return readHebrew(
        'הקלד את תוכן התגובה',
        buildCallback('reply_text')
      );

    case 'previous_message':
      return previousMessage(session);

    case 'forward':
      session.flow = 'forward';
      session.step = 'forward_recipient_mode';

      return recipientModeQuestion('forward_recipient_mode');

    case 'toggle_read':
      return toggleRead(session);

    case 'next_message':
      return nextMessage(session);

    case 'delete_message':
      return deleteCurrentMessage(session);

    case 'blacklist':
      return blacklistSender(session);

    case 'unused':
      return say('פעולה זו אינה פעילה כרגע') + '&' + messageMenu();

    case 'attachments':
      return say('ניהול קבצים מצורפים יתווסף בשלב הבא') +
        '&' + messageMenu();

    case 'add_contact':
      return addContactInstruction(session);

    default:
      return messageMenu();
  }
}


async function toggleRead(session) {
  const message = session.currentMessage;

  if (!message) {
    return say('אין הודעה נבחרת') + '&' + listenMenu();
  }

  if (message.is_unread) {
    await appsScript('mark_read', {
      message_id: message.id
    });

    message.is_unread = false;

    return say('המייל סומן כנקרא') + '&' + messageMenu();
  }

  await appsScript('mark_unread', {
    message_id: message.id
  });

  message.is_unread = true;

  return say('המייל סומן כלא נקרא') + '&' + messageMenu();
}


async function deleteCurrentMessage(session) {
  if (!session.currentMessage) {
    return say('אין הודעה נבחרת') + '&' + listenMenu();
  }

  await appsScript('trash_message', {
    message_id: session.currentMessage.id
  });

  session.messages.splice(session.index, 1);

  if (session.index >= session.messages.length) {
    session.index = Math.max(0, session.messages.length - 1);
  }

  if (session.messages.length === 0) {
    return say('המייל נמחק') + '&' + listenMenu();
  }

  return say('המייל הועבר לאשפה') +
    '&' +
    await showCurrentMessage(session);
}


async function blacklistSender(session) {
  if (!session.currentMessage) {
    return say('אין הודעה נבחרת') + '&' + messageMenu();
  }

  /*
   * כאן יש לשמור את הכתובת במסד נתונים של Render.
   * בדוגמה היא נשמרת בזיכרון בלבד.
   */
  if (!globalThis.blacklist) {
    globalThis.blacklist = new Set();
  }

  globalThis.blacklist.add(
    extractEmail(session.currentMessage.from)
  );

  return say('השולח נוסף לרשימת חסימת הצינתוקים') +
    '&' +
    messageMenu();
}


function addContactInstruction() {
  return say(
    'הוספת אנשי קשר תבוצע בשלב הבא לאחר חיבור People API.'
  ) + '&' + messageMenu();
}


/* =========================================================
   Apps Script communication
========================================================= */

async function appsScript(action, data) {
  const payload = {
    action,
    secret: RENDER_SECRET,
    ...data
  };

  const response = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error('APPS_SCRIPT_HTTP_' + response.status);
  }

  const json = await response.json();

  if (!json.ok) {
    throw new Error(json.error || 'APPS_SCRIPT_ERROR');
  }

  return json.result;
}


/* =========================================================
   Session
========================================================= */

function getSession(apiCallId) {
  const id = String(apiCallId || 'unknown');

  if (!sessions.has(id)) {
    sessions.set(id, {
      apiCallId: id,
      flow: null,
      step: null,
      messages: [],
      index: 0
    });
  }

  return sessions.get(id);
}


function saveSession(apiCallId, session) {
  sessions.set(String(apiCallId || 'unknown'), session);
}


/* =========================================================
   Request parsing
========================================================= */

function normalizeInput(body) {
  const input = body || {};

  return {
    apiCallId: input.ApiCallId || input.apiCallId || '',
    phone: input.ApiPhone || input.apiPhone || '',
    extension: input.ApiExtension || input.apiExtension || '',

    action: input.action || '',
    message_action: input.message_action || '',

    digits: input.Digits || input.digits || '',
    text: input.text || input.Text || input.value || '',

    value: input.value || '',
    message_id: input.message_id || '',
    label: input.label || '',
    label_index: input.label_index || ''
  };
}


function isYemotRequestAllowed(req) {
  /*
   * אין בדיקת ApiPhone.
   * אין להסתמך על ApiCallId כאמצעי אבטחה.
   *
   * את ה-secret מומלץ להעביר בפרמטר קבוע:
   * api_add_0=key=YEMOT_SECRET
   */
  const supplied =
    req.body?.key ||
    req.body?.secret ||
    req.query?.key ||
    '';

  if (YEMOT_SECRET && supplied !== YEMOT_SECRET) {
    return false;
  }

  const userAgent = String(req.headers['user-agent'] || '');

  if (
    userAgent &&
    !userAgent.includes('yemot-core-api')
  ) {
    return false;
  }

  return true;
}


/* =========================================================
   Yemot response builders
========================================================= */

function say(text) {
  return 'id_list_message=t-' + encodeYemotText(text);
}


/*
 * חשוב:
 * תחביר read יכול להשתנות לפי סוג הקלטה שהגדרת בימות.
 * כאן מופיע המבנה המקובל:
 *
 * read=טקסט=שם_פרמטר,,מקסימום,מינימום,סוג_מקלדת,no
 */
function readHebrew(question, callback) {
  return [
    'id_list_message=t-' + encodeYemotText(question),
    'read=' + encodeYemotText(question) +
      '=text,,1000,1,HebrewKeyboard,no',
    callback
  ].join('&');
}


function readEnglish(question, callback) {
  return [
    'id_list_message=t-' + encodeYemotText(question),
    'read=' + encodeYemotText(question) +
      '=text,,1000,1,EnglishKeyboard,no',
    callback
  ].join('&');
}


function readEmail(question, callback) {
  return [
    'id_list_message=t-' + encodeYemotText(question),
    'read=' + encodeYemotText(question) +
      '=text,,320,3,EmailKeyboard,no',
    callback
  ].join('&');
}


function readDigits(name, min, max, callback) {
  return [
    'read=' + name +
      '=input,, ' + max + ',' + min + ',DigitsKeyboard,no',
    callback
  ].join('&').replace(/ /g, '');
}


function buildCallback(action) {
  /*
   * הפעולה הבאה תגיע חזרה ל-Render בפרמטר action.
   * אם אצלך הגדרת READ מחזירה את שם הפרמטר ולא action,
   * יש למפות אותו ב-normalizeInput.
   */
  return 'action=' + encodeURIComponent(action);
}


function callbackActions(map) {
  return 'actions=' + encodeURIComponent(JSON.stringify(map));
}


function goBack() {
  return 'go_to_folder=';
}


function encodeYemotText(text) {
  return encodeURIComponent(String(text))
    .replace(/%20/g, '+');
}


function formatMessageForSpeech(message) {
  let result = '';

  result += `מאת ${cleanForSpeech(message.from)}. `;
  result += `נושא ${cleanForSpeech(message.subject || 'ללא נושא')}. `;
  result += cleanForSpeech(message.body || 'אין תוכן');

  return result.substring(0, 12000);
}


function cleanForSpeech(text) {
  return String(text)
    .replace(/https?:\/\/\S+/g, ' קישור ')
    .replace(/\s+/g, ' ')
    .trim();
}


function isEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}


function extractEmail(value) {
  const match = String(value).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : String(value);
}
