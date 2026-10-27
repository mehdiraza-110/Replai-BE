// Natural, varied business email text for warm-up traffic. Every message is assembled from interchangeable parts
// ({a|b|c} picks one) so no two emails share a fingerprint. Kept short and plain: warm-up mail should read like an
// ordinary note between colleagues, with no links, tracking or sales language.

const pick = (list) => list[Math.floor(Math.random() * list.length)];

/** Resolves every {a|b|c} group (innermost first) to one random option. */
function spin(template) {
  let out = String(template);
  for (let i = 0; i < 12 && /\{[^{}]*\|[^{}]*\}/.test(out); i += 1) {
    out = out.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, group) => pick(group.split("|")));
  }
  return out;
}

const TOPICS = [
  "the schedule for next week", "the draft proposal", "our planning notes", "the quarterly numbers", "the vendor shortlist",
  "the onboarding checklist", "the project timeline", "the meeting agenda", "the budget review", "the client feedback",
  "the updated process document", "the team availability", "the training session", "the travel plans", "the contract wording",
  "the roadmap priorities", "the office move", "the webinar details", "the survey results", "the pricing discussion",
];

const SUBJECTS = [
  "Quick question about {TOPIC}", "Following up on {TOPIC}", "Thoughts on {TOPIC}?", "{TOPIC} - a few notes",
  "Re: {TOPIC}", "Checking in on {TOPIC}", "Can we talk through {TOPIC}?", "Update on {TOPIC}", "Need your input on {TOPIC}",
  "Touching base about {TOPIC}", "Small change to {TOPIC}", "A note on {TOPIC}", "Agenda for {TOPIC}", "Before we finalize {TOPIC}",
  "Question on {TOPIC}", "Next steps for {TOPIC}", "Lunch this week?", "Quick sync tomorrow", "Catching up", "Short favor to ask",
];

const GREETINGS = ["Hi {NAME},", "Hello {NAME},", "Hey {NAME},", "Hi {NAME} -", "{NAME},", "Good morning {NAME},", "Hi there {NAME},"];

const OPENERS = [
  "{I hope your week is going well.|Hope you're having a good week.|I hope things are going smoothly on your side.|Hope all is well.}",
  "{Thanks again for your time earlier.|Thanks for getting back to me last time.|Appreciate the quick reply the other day.}",
  "{I wanted to follow up on|I was going over|I've been thinking about|Just a quick note about} {TOPIC}.",
  "{Quick one from me.|Short note from my end.|Wanted to run something by you.}",
];

const MIDDLES = [
  "{I looked it over again|I went through it once more|I reviewed it this morning} and {everything looks good on my end|I think we're mostly aligned|I only have a couple of small questions}.",
  "{Would Thursday afternoon work for a short call?|Do you have a few minutes this week to talk it through?|Let me know a time that suits you and I'll make it work.}",
  "{If it helps, I can put together a short summary beforehand.|I can send over the latest version if you want to take a look.|Happy to share my notes ahead of time.}",
  "{The main open point is the timing.|The only thing I'm unsure about is the order of the steps.|I'd like to hear how you see the priorities.}",
  "{A couple of people on the team mentioned it too, so it seems worth a proper look.|It might be worth getting one more opinion before we decide.|I think we have enough to move forward.}",
  "{There's no rush on this.|Whenever you get a chance is fine.|Sooner is better if you can, but no pressure.}",
  "{I made a few small edits and kept the rest as it was.|Nothing major has changed since we last spoke.|I added a short section at the end covering the open items.}",
  "{We can keep it informal.|It should only take ten minutes.|No need to prepare anything.}",
];

const CLOSERS = [
  "{Thanks!|Thank you.|Many thanks.|Appreciate it.}",
  "{Let me know what you think.|Looking forward to hearing from you.|Talk soon.|Speak soon.}",
  "{Best,|Regards,|Kind regards,|Thanks,|Cheers,|All the best,}",
];

/** First-touch message from one of our mailboxes to a seed. */
function buildInitial({ seedName, senderName }) {
  const topic = pick(TOPICS);
  const middle = [...MIDDLES].sort(() => Math.random() - 0.5).slice(0, 2 + Math.floor(Math.random() * 2));
  const paragraphs = [
    spin(pick(GREETINGS).replace("{NAME}", seedName || "there")),
    spin(pick(OPENERS).replace(/\{TOPIC\}/g, topic)),
    spin(middle.join(" ")),
    spin(pick(CLOSERS.slice(0, 2))),
    `${spin(CLOSERS[2])}\n${senderName}`,
  ];
  return {
    subject: spin(pick(SUBJECTS).replace(/\{TOPIC\}/g, topic)),
    body: paragraphs.join("\n\n"),
  };
}

const SEED_REPLIES = [
  "{Thanks for the note.|Thanks for reaching out.|Good to hear from you.} {That works for me.|Sounds good.|I think that makes sense.} {Let's do it.|Let me know how you'd like to proceed.|I'll take a look and get back to you.}",
  "{Appreciate the update.|Thanks, this is helpful.|Got it, thank you.} {I'll review it later today.|I'll go through it and follow up.|Give me until tomorrow to think it over.}",
  "{Hi,|Hello,|Hey,} {thanks for sending this over.|this is useful, thank you.|nice to hear from you.} {Thursday afternoon works well for me.|I'm free later this week if you want to talk.|Feel free to send a couple of times.}",
  "{Thanks!|Thank you.|Great, thanks.} {I had a few thoughts on this as well.|I'm aligned with most of it.|A couple of small questions, but nothing blocking.} {Talk soon.|Speak soon.|Best,}",
  "{Sounds good to me.|That looks fine.|I agree.} {Please go ahead.|Let's move forward with it.|Send over the details when you can.}",
  "{Perfect, thanks for the quick follow-up.|Thanks for the reminder.|Appreciated.} {I'll get back to you shortly.|I'll check with the team and confirm.|Let me confirm on my side.}",
];

const COUNTER_REPLIES = [
  "{Great, thanks for confirming.|Perfect, thank you.|Thanks for the quick answer.} {I'll follow up with the details.|I'll send the rest over shortly.|Talk to you soon.}",
  "{Appreciate it.|Thanks again.|Wonderful.} {I'll make a note of that.|That helps a lot.|We'll go with that.}",
  "{Sounds like a plan.|Understood.|Got it.} {Speak soon.|Have a good rest of your week.|Thanks for your help.}",
  "{Thank you, that's what I needed.|Thanks, noted.|Excellent, thanks.} {I'll circle back if anything changes.|Let's keep in touch.|Have a great day.}",
];

function buildSeedReply() {
  return spin(pick(SEED_REPLIES));
}

function buildCounterReply({ senderName }) {
  return `${spin(pick(COUNTER_REPLIES))}\n\n${spin("{Best,|Thanks,|Regards,|Cheers,}")}\n${senderName}`;
}

// ---- American names for generated mailboxes ----
const FIRST_NAMES = [
  "James", "Michael", "Robert", "David", "William", "Richard", "Joseph", "Thomas", "Christopher", "Daniel", "Matthew", "Anthony",
  "Mark", "Steven", "Andrew", "Joshua", "Kevin", "Brian", "Jason", "Ryan", "Eric", "Justin", "Brandon", "Adam", "Nathan", "Tyler",
  "Aaron", "Jacob", "Ethan", "Patrick", "Sean", "Gregory", "Scott", "Benjamin", "Samuel", "Jonathan", "Lucas", "Dylan", "Peter", "Carl",
  "Mary", "Jennifer", "Linda", "Elizabeth", "Susan", "Jessica", "Sarah", "Karen", "Lisa", "Nancy", "Ashley", "Emily", "Amanda", "Melissa",
  "Rachel", "Laura", "Megan", "Hannah", "Olivia", "Natalie", "Rebecca", "Katherine", "Stephanie", "Christine", "Allison", "Heather", "Amy", "Julie",
];
const LAST_NAMES = [
  "Anderson", "Baker", "Bennett", "Brooks", "Campbell", "Carter", "Clark", "Collins", "Cooper", "Cox", "Davis", "Edwards", "Evans", "Fisher",
  "Foster", "Gray", "Green", "Hall", "Harris", "Hayes", "Henderson", "Hughes", "Jackson", "Jenkins", "Johnson", "Kelly", "King", "Lewis",
  "Martin", "Miller", "Mitchell", "Moore", "Morgan", "Morris", "Murphy", "Nelson", "Parker", "Patterson", "Perry", "Peterson", "Phillips", "Reed",
  "Reynolds", "Richardson", "Roberts", "Rogers", "Russell", "Scott", "Simmons", "Smith", "Stewart", "Sullivan", "Taylor", "Thompson", "Turner", "Walker",
  "Ward", "Watson", "White", "Williams", "Wilson", "Wood", "Wright", "Young",
];

const slug = (s) => String(s).toLowerCase().replace(/[^a-z]/g, "");

/** `count` distinct people for one domain; `used` (Set of local-parts / "first last") prevents repeats across the batch. */
function generatePeople(count, used = new Set()) {
  const people = [];
  let guard = 0;
  while (people.length < count && guard < 2000) {
    guard += 1;
    const first = pick(FIRST_NAMES);
    const last = pick(LAST_NAMES);
    const key = `${first} ${last}`;
    if (used.has(key)) continue;
    used.add(key);
    people.push({ firstName: first, lastName: last, displayName: key, localPart: `${slug(first)}.${slug(last)}` });
  }
  return people;
}

module.exports = { spin, pick, buildInitial, buildSeedReply, buildCounterReply, generatePeople };
