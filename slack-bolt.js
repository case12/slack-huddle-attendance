const { App } = require("@slack/bolt");
const _ = require("lodash");
require("dotenv").config();

// Keep track of all the channels that a tally has been requested
const channelsRequestedSet = new Set();
const channelIdToMessageTs = {};

// Variables to grab the botId and botUserId for filtering / deleting bot messages
let botId;
let botUserId;

const app = new App({
  token: process.env.BOT_TOKEN,
  signingSecret: process.env.SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  port: process.env.PORT || 3000,
});

async function getChannelMemberIds(channelId) {
  try {
    const result = await app.client.conversations.members({
      channel: channelId,
    });

    if (result.ok) {
      const members = result.members;
      return members;
    } else {
      console.error("Failed to retrieve channel members:", result.error);
    }
  } catch (error) {
    console.error("Failed to make API request:", error);
  }
}

async function getMemberInfo(memberId) {
  try {
    const result = await app.client.users.info({
      user: memberId,
    });

    if (result.ok) {
      const memberInfo = result.user;
      return memberInfo;
    } else {
      console.error("Failed to retrieve member information:", result.error);
    }
  } catch (error) {
    console.error("Failed to make API request:", error);
  }
}

async function updateMonitoredChannels() {
  await Promise.all(
    Array.from(channelsRequestedSet).map((channelId) =>
      throttledUpdateMessage(channelId)
    )
  );
}

async function getAttendanceString(channel_id) {
  const channelMemberIds = await getChannelMemberIds(channel_id);

  const memberInfoPromises = channelMemberIds.map((memberId) =>
    getMemberInfo(memberId)
  );
  const memberInfoResults = await Promise.all(memberInfoPromises);
  const channelMessage = memberInfoResults
    .map((memberInfo) =>
      memberInfo.id !== botUserId &&
      memberInfo.profile.huddle_state !== "in_a_huddle"
        ? `${
            memberInfo.profile.display_name ||
            memberInfo.profile.last_name ||
            memberInfo.profile.first_name
          }?`
        : undefined
    )
    .filter((v) => v)
    .sort()
    .join(" ");

  return channelMessage;
}

async function postMessage(channel_id) {
  await deleteBotMessages(channel_id);
  const attendanceString = await getAttendanceString(channel_id);

  const result = await app.client.chat.postMessage({
    channel: channel_id,
    text: attendanceString,
  });

  if (result.ok) {
    const messageTs = result.ts;
    channelIdToMessageTs[channel_id] = messageTs;
  }
}

const throttledUpdateMessage = _.throttle(updateMessage, 3000);

async function updateMessage(channelId) {
  const attendanceString = await getAttendanceString(channelId);
  const messageTs = channelIdToMessageTs[channelId];

  await app.client.chat.update({
    channel: channelId,
    text: attendanceString,
    ts: messageTs,
  });
}

async function deleteBotMessages(channelId) {
  try {
    const result = await app.client.conversations.history({
      channel: channelId,
      limit: 100,
    });

    if (result.ok) {
      const messages = result.messages;
      const botMessages = messages.filter(
        (message) => message.bot_id === botId
      );

      if (botMessages.length > 0) {
        for (const message of botMessages) {
          await app.client.chat.delete({
            channel: channelId,
            ts: message.ts,
          });
        }
        console.log(
          `Deleted ${botMessages.length} bot messages in channel ${channelId}`
        );
      } else {
        console.log("No bot messages found in the channel");
      }
    } else {
      console.error("Failed to retrieve channel history:", result.error);
    }
  } catch (error) {
    console.error("Failed to make API request:", error);
  }
}

app.command("/tally", async ({ command, ack, context }) => {
  try {
    await ack();

    botId = context.botId;
    botUserId = context.botUserId;

    const { channel_id, text } = command;

    const argumentsArray = text.split(" ");

    if (argumentsArray.includes("off")) {
      channelsRequestedSet.delete(channel_id);
      await deleteBotMessages(channel_id);
    } else {
      channelsRequestedSet.add(channel_id);
      await postMessage(channel_id);
    }
  } catch (error) {
    console.error('Failed to process "/tally" command:', error);
  }
});

app.event("user_huddle_changed", updateMonitoredChannels);

(async () => {
  await app.start();

  console.log("⚡️ Bolt app is running!");
})();
