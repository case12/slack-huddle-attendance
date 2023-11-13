const { App } = require("@slack/bolt");
const _ = require("lodash");
require("dotenv").config();

// Keep track of all the channels that a tally has been requested
const channelsRequestedSet = new Set();
const channelIdToMessageTs = {};
const channelIdToCloseBotTimeoutId = {};

// Variables to grab the botId and botUserId for filtering / deleting bot messages
let botId;

const DEBUG = false;

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
  try {
    await Promise.all(
      Array.from(channelsRequestedSet).map((channelId) =>
        throttledUpdateMessage(channelId)
      )
    );
  } catch (error) {
    console.error("Failed updating monitored channels", error);
  }
}

function getMemberNameInfoFields(member) {
  return {
    name: member.name,
    real_name: member.real_name,
    real_name_normalized: member.profile.real_name_normalized,
    display_name: member.profile.display_name,
    first_name: member.profile.first_name,
    last_name: member.profile.last_name,
  };
}

function getBlockFromMemberInfo(memberInfo) {
  const name = memberInfo.real_name;
  const statusText = memberInfo.profile.status_text;
  const statusEmoji = memberInfo.profile.status_emoji;

  return {
    type: "context",
    elements: [
      {
        type: "image",
        image_url: memberInfo.profile.image_32,
        alt_text: name,
      },
      {
        type: "plain_text",
        emoji: true,
        text: `${name}${statusText ? ` | ${statusText}` : ""}${
          statusEmoji ? ` | ${statusEmoji}` : ""
        }`,
      },
    ],
  };
}

async function getAttendanceBlocks(channel_id) {
  const channelMemberIds = await getChannelMemberIds(channel_id);

  const memberInfoPromises = channelMemberIds.map((memberId) =>
    getMemberInfo(memberId)
  );
  const memberInfoResults = await Promise.all(memberInfoPromises);

  if (DEBUG) {
    console.log(
      memberInfoResults
        .filter((m) => m.real_name.includes("Zach"))
        .map((m) => m.profile.status_emoji_display_info)
    );

    console.log(memberInfoResults);
    // console.log(memberInfoResults.map(getMemberNameInfoFields));
  }

  const memberBlocks = memberInfoResults
    .sort((m) => m.real_name)
    .filter((m) => !m.is_bot && m.profile.huddle_state !== "in_a_huddle")
    .map(getBlockFromMemberInfo);

  return _.compact([
    memberBlocks.length === 0 && {
      type: "section",
      text: {
        type: "plain_text",
        text: "Bueller?",
      },
    },
    ...memberBlocks,
    {
      type: "actions",
      block_id: "actions1",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            emoji: true,
            text: ":sports-car:",
          },
          value: "button_close",
          action_id: "button_close",
        },
      ],
    },
  ]);
}

async function postMessage(channel_id) {
  try {
    await deleteBotMessages(channel_id);
    const attendanceBlocks = await getAttendanceBlocks(channel_id);

    if (DEBUG) {
      console.log(attendanceBlocks);
      return;
    }

    const result = await app.client.chat.postMessage({
      channel: channel_id,
      text: "Bueller?",
      blocks: attendanceBlocks,
    });

    if (result.ok) {
      const messageTs = result.ts;
      channelIdToMessageTs[channel_id] = messageTs;
    }
  } catch (error) {
    console.error(`Failed to post message in channel ${channel_id}`, error);
  }
}

const throttledUpdateMessage = _.throttle(updateMessage, 3000);

async function updateMessage(channelId) {
  try {
    const attendanceBlocks = await getAttendanceBlocks(channelId);
    const messageTs = channelIdToMessageTs[channelId];

    if (DEBUG) {
      console.log(attendanceBlocks);
      return;
    }

    await app.client.chat.update({
      channel: channelId,
      blocks: attendanceBlocks,
      ts: messageTs,
      text: "Bueller?",
    });
  } catch (error) {
    console.error(`Failed to update message in channel ${channelId}`, error);
  }
}

async function deleteBotMessages(channelId) {
  try {
    const result = await app.client.conversations.history({
      channel: channelId,
      limit: 100,
    });

    if (DEBUG) {
      console.log(`Delete bot messages in channel ${channelId}`);
    }

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

app.command("/bueller", async ({ command, ack, context }) => {
  try {
    await ack();

    botId = context.botId;
    botUserId = context.botUserId;

    const { channel_id } = command;

    channelsRequestedSet.add(channel_id);
    await postMessage(channel_id);

    clearTimeout(channelIdToCloseBotTimeoutId[channel_id]);

    channelIdToCloseBotTimeoutId[channel_id] = setTimeout(() => {
      channelsRequestedSet.delete(channel_id);
      deleteBotMessages(channel_id);
    }, 120000);
  } catch (error) {
    console.error('Failed to process "/bueller" command:', error);
  }
});

app.action("button_close", async ({ ack, body }) => {
  try {
    await ack();

    const channelId = body.channel.id;

    channelsRequestedSet.delete(channelId);
    await deleteBotMessages(channelId);
  } catch (error) {
    console.error("Error handling button press:", error);
  }
});

async function monitorChannelsRequested() {
  // Regular function wrapper for the async function
  function timerCallbackWrapper() {
    updateMonitoredChannels().catch((error) => {
      console.error("Error in asyncTimerCallback:", error);
    });
  }

  // Start the timer
  setInterval(timerCallbackWrapper, 3000); // 3000 ms = 3 seconds
}

// app.event("user_huddle_changed", updateMonitoredChannels);

(async () => {
  await app.start();

  await monitorChannelsRequested();

  console.log("⚡️ Bolt app is running!");
})();
