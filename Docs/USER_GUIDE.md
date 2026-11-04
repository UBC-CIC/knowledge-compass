# User Guide

Knowledge Compass is Inclusion Canada's assistant for families navigating inclusive education in Canada: a child being sent home early or kept on a reduced schedule, being left out of school activities, changing schools or moving to high school, and planning supports. Answers come from content Inclusion Canada has reviewed, and each answer links to its sources.

This guide covers the family chat and the admin console. To deploy the app first, see the [Deployment Guide](./DEPLOYMENT_GUIDE.md).

| Section | What it covers |
| ----- | ----------- |
| [For families](#for-families) | Starting a conversation, reading answers, sources and warnings, managing earlier conversations |
| [For administrators](#for-administrators) | Signing in, content, prompts and journeys, guides, settings, analytics and feedback, the search index |
| [Adding content](#adding-content) | Step-by-step: websites, documents, video transcription, CSV and Markdown |

---

## For families

### Getting started

Open the app's web address (the Amplify URL from deployment, or your custom domain). There is no account and no sign-in. The browser keeps a private key for you, so your conversations stay on that device and browser. Using another device or browser, or clearing site data, starts fresh.

The welcome screen shows Inclusion Canada's welcome message, a disclaimer (the assistant shares reviewed guidance, isn't legal advice, and can make mistakes), and three starters:

- My child keeps getting sent home before lunch
- My child is being left out of field trips and activities
- We're getting ready for the move to high school

Pick a starter or describe what is happening in your own words.

### How a conversation works

The assistant usually asks one or two questions first, one at a time, so it understands your situation (for example your child's age, the province, and what the school has said). Once the situation is clear it gives guidance: practical steps, what to ask for, and how to work with the school. Urgent situations, such as the school asking you to pick up your child now, are answered right away.

The assistant stays on your child's schooling. It handles hard topics with care, including harm or restraint at school, a child's thoughts of self-harm, and worries about legal options, but it gives general information, not legal advice. If you want to contact or meet with the school, it helps you prepare with tips on what to include and what to ask. You write the email or letter in your own words. Requests that aren't about a child's schooling are politely declined.

Personal details such as names, phone numbers, email and street addresses, and health or SIN numbers are removed from your message before it is saved or sent to the AI model. If the app spots likely personal details as you send, a note under your message says they will be redacted. You don't need to include them to get help.

### Sources and warnings

- **More resources.** Under an answer, cards link to the web pages, documents and videos it was drawn from. Video cards open at the relevant moment. A resource without a public link shows its title only.
- **Family guide.** When the answer follows one of Inclusion Canada's family guides, a "Family guide: [situation]" card names the section. The guide itself is not linked.
- **Warnings.** After each answer, the app checks it against its sources. If the support looks weak, a warning appears under the answer suggesting you double-check important details with your school or a trusted advocate. You can dismiss it.

### Earlier conversations

The sidebar lists your earlier conversations under **Earlier conversations**. Use **Start a new conversation** to begin another. Each conversation's menu lets you:

- **Export chat:** download the conversation as a text file.
- **Rename** it.
- **Delete** it.

To protect your privacy, conversations are cleared after 90 days without a visit.

### Feedback

Under the latest answer, **Was this helpful?** lets you rate the conversation and add an optional comment. Please don't include names or personal details. You can change your rating or comment later.

### Limits and notices

To keep the service available for everyone, there are daily limits on how many messages and characters each person can send, how many new conversations they can start (20 per day), and how many messages everyone can send in total. When a limit is reached, the assistant says so and when to try again. Sending many messages quickly brings a short "please wait a moment" message.

Inclusion Canada may show a notice above the chat, for example about planned maintenance. If messages are paused, you can still read earlier conversations. If the chat can't start, the app explains whether to wait a few minutes and try again or come back later.

---

## For administrators

### Signing in

Administrator accounts are created by an existing administrator (or, for the first one, in the Cognito console; see [Deployment Guide, Configure Admin User](./DEPLOYMENT_GUIDE.md#step-2-configure-admin-user)). Public sign-up is not available.

1. Go to `<app URL>/admin/login`.
2. Enter your email and password. On first sign-in you set a new password.
3. Set up two-step verification: open an authenticator app (such as Google Authenticator or Microsoft Authenticator), add an account with the setup key or link shown, and enter the six-digit code. Later sign-ins ask for a code from the app.

Bookmark `<app URL>/admin/login` to come back to the console. The logo in the console takes you to the family chat.

The console sidebar has five pages: **Overview**, **Analytics**, **Prompts**, **Assistant settings** and **Search index**. Changes to prompts, journeys, guides, settings, feedback triage and data sources are recorded in an audit log with your identity.

### Overview: usage and data sources

The top of the page shows **Users reached**, **Conversations** and **Messages exchanged** across all time.

**Data sources** lists everything the assistant can answer from, with each item's type, status (Pending, Transcribing, Queued, Running, Completed or Failed), and upload and completion times. Search by name or type.

To add websites, documents, videos or spreadsheets, see [Adding content](#adding-content).

For each item, the actions let you re-queue a failed item for the next sync or delete it. Deleting removes its content from the assistant's answers. For CSVs with links, the link view shows each row's fetch and indexing status; use **Refresh** to update it.

### Adding content

The assistant can only answer from content you add here. All of it is added from **Overview → Data sources**. Documents and videos need a public link families can open, because that link is what the assistant cites; uploaded files are never shown to families.

| Content | How it is added | When it goes live |
|---|---|---|
| Website | **Add web URL** | After you click **Sync now** |
| Document (PDF, Word, text) | **Upload files, video, or documents → Document** | Automatically after upload, usually within a few minutes (scanned PDFs take longer) |
| Video or audio | **Upload files, video, or documents → Video** | Automatically once transcription finishes; longer recordings take longer |
| CSV or Markdown | **Upload files, video, or documents → Single File** or **Zip Upload** | After you click **Sync now** |

#### Add a website

1. Click **Add web URL**.
2. Enter the site's public address, for example `https://www.example.org/inclusive-education`. Only public `http` or `https` addresses are accepted.
3. Leave **Include patterns** and **Exclude patterns** empty. They are saved but not yet applied, so the crawler reads the whole site from that address.
4. Click **Stage URL**. The website appears in the table as **Pending**.
5. Click **Sync now**. The status changes to **Queued**, then **Running**, then **Completed**.

The crawler follows links on the same site, up to 50 pages, and each page becomes its own source that answers can cite. Adding an address that is already in the table is rejected. To pick up later changes on the site, delete the website, add it again and click **Sync now**.

#### Add a document

1. Click **Upload files, video, or documents** and open the **Document** tab.
2. Drag in or choose a PDF, Word (`.docx`) or text (`.txt`) file, up to 50 MB. Save older `.doc` files as `.docx` first.
3. Check the **Title**. It is filled in from the file name; change it to what families should see, for example "Family rights handbook".
4. Enter the **Public link (required)**: an `http` or `https` address where families can open the document, such as its page on your website. Answers cite this link, never the uploaded file.
5. Click **Upload & embed**. The text is read and added automatically; you do not need to click Sync now.

Scanned or image-only PDFs are read with text recognition, which can take several minutes. To update a document, upload the new version with the same file name: it replaces the old one, and only the changed text is processed again.

#### Add a video (transcription)

1. Click **Upload files, video, or documents** and open the **Video** tab.
2. Drag in or choose the recording: video (`.mp4`, `.m4v`, `.webm`) or audio (`.mp3`, `.m4a`, `.wav`, `.flac`, `.ogg`, `.amr`), up to 1 GB. Upload the file itself; the app cannot download a video from YouTube.
3. Check the **Title**, for example "Inclusive education webinar".
4. Enter the **Public video URL**, usually the YouTube link. Answers cite this link, and video cards open it at the moment that supports the answer.
5. Click **Upload & transcribe**. Amazon Transcribe creates the transcript, then the transcript is split by timestamp and added automatically. The item shows **Transcribing** while the transcript is made; you do not need to click Sync now.

A video URL that is already used by a crawled web page or another source is rejected, so each video is added once.

#### Add a CSV or Markdown file

1. Click **Upload files, video, or documents** and open the **Single File** tab.
2. Choose the CSV or Markdown file. A CSV needs a header row.
3. Add the matching metadata file. It must be named exactly `<file name>.metadata.json` (for example `guidance-resources.csv.metadata.json`). The dialog shows an example you can copy or download.
4. For a CSV whose rows each link to a web page or PDF, choose the link column. Optionally choose the columns for a stable row id, title, description and the link families should see. The assistant then fetches each linked page and can cite individual rows.
5. Click **Upload & Stage**, then **Sync now**.

To add several files at once, put each file and its metadata file in one `.zip` and use the **Zip Upload** tab.

#### Check that content is live

- The table shows each item's status. **Completed** means its content is searchable; a **Failed** item shows the reason. Fix the cause (for example a broken link or an unreadable file), then use the re-queue action and click **Sync now**.
- Ask a question in the family chat that the new content answers, and check that it appears under **More resources**.

For how ingestion works and how to troubleshoot it, see [Knowledge Base Documentation](./KNOWLEDGE_BASE_DOCUMENTATION.md#monitoring-and-debugging).

### Prompts

The Prompts page holds the instructions the assistant follows. Changes reach new messages within about five minutes. Every page keeps its history, so you can go back to an earlier version. Edit, then **Save and publish**, or discard your changes.

**Shared by every journey:**

- **The assistant:** who it is (**Who it is**), what it must never do (**Boundaries**) and Inclusion Canada's **Preferred language**. The app adds the journey list and a fixed topic rule automatically. That rule keeps the assistant on a child's schooling and gives tips rather than written messages for contacting the school, and editing Boundaries cannot remove it.
- **How it talks:** how the assistant runs a conversation while **Asking questions** and when **Giving guidance**.
- **Guides:** the uploaded guides for guideline mode (see [Guideline mode](#guideline-mode)).

**Journeys.** A journey is a kind of family situation (for example, a child sent home early). Use **Add journey** to create one and the search box to find one. Each journey has:

- **Who it's for:** a sentence or two that helps the assistant recognise the journey.
- **Words families use:** phrases, separated by commas.
- **Questions to ask:** asked one at a time, in order, while the assistant learns where the family is.
- **How to guide:** added to every guidance reply in this journey.
- **Situations:** specific needs within the journey. Each has **Use this when…** and **Steps to follow**. Use **Add situation** to create one.

If the assistant can't tell which situation fits, it uses the journey's guidance with all of its situations. If the journey is unclear too, it uses every journey. Archiving a journey or situation stops the assistant using it; you can restore it later. Each journey and situation shows its recent family ratings.

**Shown on screen:** **Welcome and disclaimer** holds the welcome message and disclaimer families see. These are not sent to the assistant.

**Preview a reply** shows which parts of the prompt the assistant receives for a chosen journey, situation and stage.

With **Show developer settings** on, a **Developers** section adds **Reply layouts**: the tagged format the app reads to show replies and sources. Leave these to a developer, because a change can break how replies display.

### Guideline mode

Guideline mode is a second way for the assistant to answer. Instead of the typed journey guidance, it follows the guides your team already uses with families. Your journeys and other prompts are not changed, so you can switch between the two and compare them.

Open **Prompts → Guides**.

- **Upload guides.** Drag in or choose Word (`.docx`, up to 10 MB), PDF (`.pdf`, up to 10 MB) or Markdown (`.md`, up to 1 MB) files. Each shows as processing, then ready once it can be searched. That usually takes under a minute; scanned PDFs can take a few minutes. Markdown gives the best results, because its headings mark exactly where each situation starts. A heading for each situation helps in any format: Word's Heading styles, `## Child sent home early` in Markdown, or a short title line in a PDF. Save older `.doc` files as `.docx` first.
- **Check the situations.** Each ready guide lists the situations it found, with a short summary. Renaming is optional and changes how a situation is matched and shown to families; **Reset to detected** restores the original name. Renamed situations keep their name when you replace the file, as long as the heading stays the same.
- **Replace or remove a guide.** **Replace** uploads a new version. **Remove** stops the assistant using it and deletes its search data.
- **Turn it on or off.** The **Answer from uploaded guides** switch applies to every family and takes up to five minutes to reach new messages. If it is on but no guide is ready, the assistant can only ask questions, and the page warns you.

In guideline mode:

- The matching guide section decides what the assistant says and which steps it gives.
- The regular data sources are still searched. The assistant can point to up to two of them when they support a step from the guide, but they never add steps or change the guide's advice. Guides are never used in standard mode.
- If no section fits clearly, or the section says to ask something first, the assistant asks one clarifying question.
- Families see a "Family guide: [situation]" source under the answer, plus any resources used.
- Boundaries, preferred language, the topic rule, daily limits and the answer check all still apply.

Developers can compare both modes on the same questions with `tests/eval/run_eval.py --mode standard|guideline` in `cdk/lambda/textGeneration`, or with the evaluation harness ([EVALS.md](./EVALS.md)).

### Assistant settings

Changes save with **Save changes** and apply to new messages without a redeploy.

- **Daily limits:**
  - Messages a person can send per day
  - Longest message a person can send (characters)
  - Characters a person can send per day (from midnight UTC)
  - Messages everyone can send per day, in total. When it is reached, the assistant pauses for everyone until the next day.
- **How the conversation flows:** when the assistant stops asking and starts guiding. Choose **Ask a few questions first** (questions for the first 4 messages), **Balanced** (at least one question, then guidance once the situation is clear, by the 3rd message at the latest) or **Answer as soon as it's clear** (guidance as soon as the situation is clear, by the 4th message at the latest). Urgent situations are always answered right away.
- **Service status** (saved on its own): **Normal**; **Show a banner** with your message above the chat; or **Pause new messages (read-only)**, where families see your message and can still read earlier chats. It takes effect within about a minute.

**Show developer settings** adds **Developer settings**: routing mode and its message counts, the longest reply length, temperature and top P (stored, but not sent to the current model), and the **Answer checks** thresholds (evidence match, topic match, reliable answer and partial warning) that decide when families see a warning. These checks never change what the assistant says. **Reset to recommended** restores the defaults in that card. Test changes in a dev environment first.

### Analytics and feedback

Choose **Last N days** (up to 365) or a **Date range**. The charts show users reached, conversations started and messages exchanged over time.

**User feedback** shows a rating summary, ratings over time, and comments families left. Filter comments by **All**, **Helpful** or **Not helpful**, and use **View reply** to read the answer a comment was left on. Comments are in three tabs:

- **Recent:** new comments in the chosen range.
- **Review later:** comments any administrator saved, from any date. A family whose feedback is saved here is kept past the 90-day clean-up until it is removed from the list or dismissed.
- **Dismissed:** comments set aside. Their ratings still count in the totals, and you can restore them to Recent.

On the Review later tab, **Download PDF** saves those conversations, including each chat, as one PDF.

### Search index

The assistant finds passages in your content with a search index built by an embedding model. To change the model, use **Register a new index**, then **Start rebuild** to build it next to the live one, **Check quality** to compare it against a set of test questions, and **Activate** to switch. Chat keeps working throughout; only syncing pauses for a few minutes during the switch. **Roll back to this index** returns to an older index, and a retired index can be deleted by typing its name to confirm.

See the [embedding model swap runbook](./runbooks/embedding-model-swap.md) for the full procedure.

---

## Additional Resources

- [Deployment Guide](./DEPLOYMENT_GUIDE.md)
- [Architecture Deep Dive](./ARCHITECTURE_DEEP_DIVE.md)
- [Knowledge Base Documentation](./KNOWLEDGE_BASE_DOCUMENTATION.md)
- [API Documentation](./API_DOCUMENTATION.md)
- [Security Overview](./SECURITY_OVERVIEW.md)
