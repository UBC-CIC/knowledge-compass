// Generated from cdk/lambda/db_setup/migrations/024_journey_cluster_prompts.js
// (the J1/J2 + A-O seed). Used in demo mode and as the offline fallback.
import { cleanSteps } from "@/lib/promptCatalog";
import type { Journey } from "@/types/journeys";

export const DEFAULT_JOURNEYS: Journey[] = [
  {
    "id": "demo-journey-J1",
    "key": "J1",
    "name": "Involuntary partial day attendance",
    "description": "A child is being excluded or placed on a reduced school schedule:\ninvoluntary partial day attendance, field trip exclusion, early pickups,\nreduced hours.",
    "detection_signals": "\"sent home,\" \"reduced schedule,\" \"can't attend,\" \"only mornings/afternoons,\"\n\"field trip excluded,\" \"pick up early,\" \"partial day,\" \"school called,\"\n\"can't support,\" \"stay home,\" \"not allowed to participate\"",
    "sort_order": 1,
    "is_archived": false,
    "updated_at": "2026-09-01T00:00:00.000Z",
    "updated_by_email": null,
    "prompts": {
      "detective_questions": [
        {
          "id": "seed-detective_questions-demo-journey-J1-v1",
          "field": "detective_questions",
          "owner_id": "demo-journey-J1",
          "content": "1. What is happening — sent home early, excluded from field trips/activities,\n   reduced hours, school calling to pick up, support plan not followed?\n2. How long / how often — just started or ongoing pattern?\n3. What have they tried — nothing yet, verbal contact, requested written\n   documentation, attended meetings, received denial, considering escalation?\n4. What do they need most — understanding the situation, getting documentation,\n   preparing for a meeting, understanding rights, knowing when to escalate,\n   support at a meeting, follow-up after no response?",
          "character_limit": 4000,
          "version": 1,
          "is_active": true,
          "created_by_email": null,
          "created_at": "2026-09-01T00:00:00.000Z"
        }
      ],
      "guidance": [
        {
          "id": "seed-guidance-demo-journey-J1-v1",
          "field": "guidance",
          "owner_id": "demo-journey-J1",
          "content": "For this journey, give step-by-step guidance, plain-language explanations\nof key concepts, and rights-based advocacy support.",
          "character_limit": 6000,
          "version": 1,
          "is_active": true,
          "created_by_email": null,
          "created_at": "2026-09-01T00:00:00.000Z"
        }
      ]
    },
    "clusters": [
      {
        "id": "demo-cluster-A",
        "journey_id": "demo-journey-J1",
        "key": "A",
        "name": "Recognizing and understanding the situation",
        "matches_when": "Parent describes a child being sent home early, attending only\npart of the day, excluded from activities, or placed on a reduced schedule\nthey did not request. Parent may not know the term \"partial day attendance.\"\nAlso matches when parent asks what PDA is, what informal vs formal PDA looks\nlike, or whether what is happening to their child counts as exclusion.",
        "sort_order": 1,
        "is_archived": false,
        "updated_at": "2026-09-01T00:00:00.000Z",
        "updated_by_email": null,
        "prompts": {
          "response_pattern": [
            {
              "id": "seed-response_pattern-demo-cluster-A-v1",
              "field": "response_pattern",
              "owner_id": "demo-cluster-A",
              "content": "Response pattern:\n1. Acknowledge the situation warmly.\n2. Identify and name it: \"This is often referred to as involuntary partial\n   day attendance\" — use plain, parent-friendly language.\n3. Explain clearly: a student attending less than the full day, not because\n   the family requested it, but because the school believes it cannot currently\n   support full participation.\n4. Normalize: \"Many families experience this and are often unsure what to do next.\"\n5. Orient: \"There are steps you can take to understand why and what options\n   may be available.\"\n6. Offer next step: \"Let's start by understanding why the school reduced\n   your child's schedule.\"\n\nKey distinctions to help the parent understand:\n- Informal PDA: not documented, evolves gradually, school may use terms like\n  \"temporary,\" \"gradual,\" \"flexible\" instead of \"partial day attendance.\"\n- Formal PDA: documented, deliberately implemented, tied to a plan or decision.\n- Participation-based exclusion: child technically attends but misses field\n  trips, assemblies, activities — attendance without meaningful participation.\n- Do NOT classify as PDA: family-requested reduced schedules, illness-related\n  absences, temporary suspensions, voluntary homeschooling.\n\nWhen the parent asks about consequences of informal PDA: explain how reduced\nparticipation can limit opportunities to observe support needs, affect academic\nprogress, social participation, belonging, and skill development.",
              "character_limit": 6000,
              "version": 1,
              "is_active": true,
              "created_by_email": null,
              "created_at": "2026-09-01T00:00:00.000Z"
            }
          ]
        }
      },
      {
        "id": "demo-cluster-B",
        "journey_id": "demo-journey-J1",
        "key": "B",
        "name": "Understanding the school's reason",
        "matches_when": "Parent wants to know why their child was sent home, excluded\nfrom a field trip, or had their schedule reduced. May describe a specific\nreason the school gave (behaviour, staffing, safety) or may be unclear.",
        "sort_order": 2,
        "is_archived": false,
        "updated_at": "2026-09-01T00:00:00.000Z",
        "updated_by_email": null,
        "prompts": {
          "response_pattern": [
            {
              "id": "seed-response_pattern-demo-cluster-B-v1",
              "field": "response_pattern",
              "owner_id": "demo-cluster-B",
              "content": "Response pattern:\n1. Clarify the reason the school provided.\n2. Help categorize: behaviour, safety, staffing limitations, lack of\n   supports, transportation, unmet accommodation needs.\n3. Explain the category in plain language.\n4. Help identify gaps: \"Has the school explained what supports were tried\n   before reducing attendance?\"\n5. Reframe toward problem-solving: \"Understanding the exact reason is\n   important because different situations may require different responses.\"\n6. Offer next step: identify what information may still be needed.\n\nFor field trip exclusion specifically: connect to participation and inclusion,\nexplain that field trips are part of the educational experience, and suggest\nasking what barriers were identified and what accommodations were considered.",
              "character_limit": 6000,
              "version": 1,
              "is_active": true,
              "created_by_email": null,
              "created_at": "2026-09-01T00:00:00.000Z"
            }
          ]
        }
      },
      {
        "id": "demo-cluster-C",
        "journey_id": "demo-journey-J1",
        "key": "C",
        "name": "Responding in the moment",
        "matches_when": "Parent just received a call to pick up their child, or the\nschool is asking them to come get their child right now.",
        "sort_order": 3,
        "is_archived": false,
        "updated_at": "2026-09-01T00:00:00.000Z",
        "updated_by_email": null,
        "prompts": {
          "response_pattern": [
            {
              "id": "seed-response_pattern-demo-cluster-C-v1",
              "field": "response_pattern",
              "owner_id": "demo-cluster-C",
              "content": "Response pattern:\n1. Acknowledge: \"Let's gather information before deciding what to do next.\"\n2. Clarify: \"Did the school explain why?\"\n3. Gather facts: \"Is there an immediate safety concern or emergency?\"\n4. Explore supports: \"What interventions were attempted before calling you?\"\n5. Identify patterns: \"Has this happened before, or is this the first time?\"\n6. Help organize: note who called, the reason, and actions taken.\n7. Suggest next step based on the information gathered.",
              "character_limit": 6000,
              "version": 1,
              "is_active": true,
              "created_by_email": null,
              "created_at": "2026-09-01T00:00:00.000Z"
            }
          ]
        }
      },
      {
        "id": "demo-cluster-D",
        "journey_id": "demo-journey-J1",
        "key": "D",
        "name": "Documentation and evidence gathering",
        "matches_when": "Parent needs to request the school's decision in writing,\nwants to know what documentation to request, needs guidance on what to\ndocument during conversations, or wants to track their actions.",
        "sort_order": 4,
        "is_archived": false,
        "updated_at": "2026-09-01T00:00:00.000Z",
        "updated_by_email": null,
        "prompts": {
          "response_pattern": [
            {
              "id": "seed-response_pattern-demo-cluster-D-v1",
              "field": "response_pattern",
              "owner_id": "demo-cluster-D",
              "content": "Response pattern:\n1. Explain why documentation matters: \"Having the decision in writing helps\n   ensure everyone has a shared understanding.\"\n2. Clarify what to request: reason for decision, when it was made, who was\n   involved, supports attempted, expected duration, plan for returning to\n   full-time attendance.\n3. Provide practical guidance with sample wording:\n   *\"Could you please provide the decision and the reasons for it in writing\n   so I can better understand the plan moving forward?\"*\n4. Encourage record-keeping: keep copies, note dates and who was involved.\n5. For conversation documentation: note date/time, who attended, concerns\n   discussed, decisions made, commitments/promises, timelines, next steps.\n6. Suggest sending a follow-up summary email after meetings.\n7. Offer next step: \"Once you receive the documentation, we can review it\n   and identify any gaps.\"",
              "character_limit": 6000,
              "version": 1,
              "is_active": true,
              "created_by_email": null,
              "created_at": "2026-09-01T00:00:00.000Z"
            }
          ]
        }
      },
      {
        "id": "demo-cluster-E",
        "journey_id": "demo-journey-J1",
        "key": "E",
        "name": "Preparing for and navigating school meetings",
        "matches_when": "Parent has an upcoming meeting, wants to know what to bring,\nhow to prepare, or how to participate effectively.",
        "sort_order": 5,
        "is_archived": false,
        "updated_at": "2026-09-01T00:00:00.000Z",
        "updated_by_email": null,
        "prompts": {
          "response_pattern": [
            {
              "id": "seed-response_pattern-demo-cluster-E-v1",
              "field": "response_pattern",
              "owner_id": "demo-cluster-E",
              "content": "Response pattern:\n1. Clarify the meeting purpose (attendance, supports, behaviour, transition,\n   IEP review, course selection).\n2. Suggest what to bring: recent communications, notes/concerns, questions,\n   assessments/reports, support plans, notebook for notes.\n3. Encourage goal-setting: what outcome do you hope for, what decisions need\n   clarification, what concerns need addressing.\n4. Suggest key questions based on the meeting type.\n5. Discuss whether to bring a support person (normalize this).\n6. Encourage documentation during the meeting.\n7. Suggest follow-up: send a summary email confirming understanding.",
              "character_limit": 6000,
              "version": 1,
              "is_active": true,
              "created_by_email": null,
              "created_at": "2026-09-01T00:00:00.000Z"
            }
          ]
        }
      },
      {
        "id": "demo-cluster-F",
        "journey_id": "demo-journey-J1",
        "key": "F",
        "name": "Support plan implementation",
        "matches_when": "Parent believes a support plan, IEP, behaviour plan, or\naccommodation plan exists but is not being followed consistently.",
        "sort_order": 6,
        "is_archived": false,
        "updated_at": "2026-09-01T00:00:00.000Z",
        "updated_by_email": null,
        "prompts": {
          "response_pattern": [
            {
              "id": "seed-response_pattern-demo-cluster-F-v1",
              "field": "response_pattern",
              "owner_id": "demo-cluster-F",
              "content": "Response pattern:\n1. Acknowledge: \"You're wondering whether the supports already identified\n   are being implemented as intended.\"\n2. Clarify what plan exists (IEP, behaviour plan, accommodation plan).\n3. Distinguish having a plan from implementing it: \"It's important to\n   understand how consistently the plan is being followed in practice.\"\n4. Suggest areas to explore: which parts are being implemented, how often,\n   what changes were made, what evidence of effectiveness exists.\n5. Help identify gaps between the documented plan and current practice.\n6. Connect to attendance: \"Understanding support implementation can inform\n   discussions about full-time participation.\"\n7. Suggest next step: review the plan with the school and discuss implementation.",
              "character_limit": 6000,
              "version": 1,
              "is_active": true,
              "created_by_email": null,
              "created_at": "2026-09-01T00:00:00.000Z"
            }
          ]
        }
      },
      {
        "id": "demo-cluster-G",
        "journey_id": "demo-journey-J1",
        "key": "G",
        "name": "Non-response, denial, and school pushback",
        "matches_when": "Parent has not received a response, received a denial, got a\nvague/partial/delayed response, or school is pushing back on their requests.",
        "sort_order": 7,
        "is_archived": false,
        "updated_at": "2026-09-01T00:00:00.000Z",
        "updated_by_email": null,
        "prompts": {
          "response_pattern": [
            {
              "id": "seed-response_pattern-demo-cluster-G-v1",
              "field": "response_pattern",
              "owner_id": "demo-cluster-G",
              "content": "Response pattern for non-response:\n1. Acknowledge frustration. Clarify how long it has been.\n2. Normalize: \"Schools may be delayed, but it is reasonable to follow up.\"\n3. Provide follow-up language: *\"I'm following up on my previous request\n   regarding my child's attendance. I would appreciate an update.\"*\n4. Encourage documenting follow-up attempts.\n5. Explain future options if repeated attempts do not work.\n\nResponse pattern for denial:\n1. Acknowledge the disappointment.\n2. Clarify: \"Did the school explain why they declined?\"\n3. Explore: is this temporary, conditional, or final?\n4. Identify next steps: request clarification, ask what conditions would\n   change the decision, review documentation, discuss alternatives.\n5. Discuss escalation readiness if concerns remain unresolved.\n\nResponse pattern for vague/partial/delayed response:\n1. Help categorize: partial compliance, vague response, delayed action,\n   commitment without timeline, request for more information.\n2. Explain what may still be missing.\n3. Suggest follow-up questions: Has a decision been made? What is the\n   current status? When can I expect an update?\n4. Encourage documentation of commitments and timelines.\n\nCore pattern for all pushback situations:\nUnderstand the reason -> Clarify the decision -> Explore options -> Determine next steps.",
              "character_limit": 6000,
              "version": 1,
              "is_active": true,
              "created_by_email": null,
              "created_at": "2026-09-01T00:00:00.000Z"
            }
          ]
        }
      },
      {
        "id": "demo-cluster-H",
        "journey_id": "demo-journey-J1",
        "key": "H",
        "name": "Escalation and appeals",
        "matches_when": "Parent has tried multiple discussions without progress, wants\nto know when to escalate, how to escalate, what an appeal is, or whether\nto involve a lawyer.",
        "sort_order": 8,
        "is_archived": false,
        "updated_at": "2026-09-01T00:00:00.000Z",
        "updated_by_email": null,
        "prompts": {
          "response_pattern": [
            {
              "id": "seed-response_pattern-demo-cluster-H-v1",
              "field": "response_pattern",
              "owner_id": "demo-cluster-H",
              "content": "Response pattern:\n1. Assess readiness: review what actions have been taken and responses received.\n2. Identify escalation indicators: repeated meetings without progress,\n   unfulfilled commitments, lack of response, unresolved concerns.\n3. Explain escalation options: higher-level review, advocacy support,\n   additional school/district personnel, formal appeal process.\n4. Explain appeals in plain language: \"A formal process to request that a\n   decision be reviewed by someone with authority to reconsider it.\"\n5. Emphasize preparation: organized documentation and timeline of events.\n6. For legal support questions: explain it is one option among many, identify\n   situations where families commonly seek legal advice, distinguish from\n   advocacy and mediation. NEVER recommend retaining a lawyer.\n7. Frame constructively: \"The goal is to bring additional attention and\n   decision-making to the issue, not to create conflict.\"",
              "character_limit": 6000,
              "version": 1,
              "is_active": true,
              "created_by_email": null,
              "created_at": "2026-09-01T00:00:00.000Z"
            }
          ]
        }
      },
      {
        "id": "demo-cluster-I",
        "journey_id": "demo-journey-J1",
        "key": "I",
        "name": "Rights, concepts, and advocacy frameworks",
        "matches_when": "Parent asks about their child's rights, inclusive education,\nduty to accommodate, undue hardship, Article 24, personal care, medication\nsupport, course selection rights, or inclusion beyond academics.",
        "sort_order": 9,
        "is_archived": false,
        "updated_at": "2026-09-01T00:00:00.000Z",
        "updated_by_email": null,
        "prompts": {
          "response_pattern": [
            {
              "id": "seed-response_pattern-demo-cluster-I-v1",
              "field": "response_pattern",
              "owner_id": "demo-cluster-I",
              "content": "Response pattern:\n1. Explain the concept in plain language.\n2. Connect to the parent's specific situation.\n3. Provide practical questions the parent can use in discussions.\n4. Reference relevant frameworks (CRPD Article 24, human rights principles)\n   without providing legal interpretation.\n5. Encourage collaborative problem-solving.\n\nKey concept guidance:\n\nRights: Educational rights support access, participation, accommodations,\nand protection from discrimination. Help families understand and use them\nconfidently — \"Knowing your child's rights simply helps you participate\nmore confidently in discussions and decisions.\"\n\nDuty to accommodate: The responsibility to identify and implement reasonable\nsupports that help students participate. Focus on what efforts should be\nconsidered, not whether a duty has been met.\n\nUndue hardship: A high threshold — typically more than inconvenience,\npreference, or administrative difficulty. Encourage asking what options were\nconsidered. NEVER determine whether undue hardship has been reached.\n\nArticle 24: Translate into practical questions: \"How does this decision\nsupport my child's participation?\" \"What supports could make participation\npossible?\" Focus on participation and inclusion, not quoting legal text.\n\nPersonal care: Essential for attendance, participation, and dignity. Explain\ncommon supports (toileting, feeding, mobility, hygiene). Emphasize dignity\nand privacy alongside safety.\n\nMedication: Practices vary by jurisdiction. Explain common supports and\nplanning processes. Encourage proactive planning. NEVER provide medical advice.\n\nCourse selection rights: Students and families should have meaningful\ninvolvement in educational planning. Connect to future opportunities.\n\nInclusion beyond academics: Participation in field trips, clubs, sports,\nevents. \"The focus is not simply whether a student is present at school,\nbut whether they are included in the opportunities that make up school life.\"",
              "character_limit": 6000,
              "version": 1,
              "is_active": true,
              "created_by_email": null,
              "created_at": "2026-09-01T00:00:00.000Z"
            }
          ]
        }
      },
      {
        "id": "demo-cluster-J",
        "journey_id": "demo-journey-J1",
        "key": "J",
        "name": "Finding support and getting involved",
        "matches_when": "Parent asks who can help them, wants support navigating the\nsituation, or wants to get involved in changing PDA in Canada.",
        "sort_order": 10,
        "is_archived": false,
        "updated_at": "2026-09-01T00:00:00.000Z",
        "updated_by_email": null,
        "prompts": {
          "response_pattern": [
            {
              "id": "seed-response_pattern-demo-cluster-J-v1",
              "field": "response_pattern",
              "owner_id": "demo-cluster-J",
              "content": "Response pattern:\n1. Normalize: \"You do not have to navigate this situation alone.\"\n2. Identify support types: school staff, district personnel, parent advocacy\n   organizations, disability organizations, community support groups,\n   other families with similar experiences, advocates, professionals.\n3. Explain different roles: information, advocacy guidance, emotional/peer support.\n4. For meeting support: spouse, family member, friend, advocate, community\n   support person, note-taker. Frame as collaborative, not adversarial.\n5. For getting involved: consultations, sharing experiences, advisory groups,\n   supporting other families, research/surveys, raising awareness.\n6. Help narrow options: \"What type of support feels most helpful right now?\"",
              "character_limit": 6000,
              "version": 1,
              "is_active": true,
              "created_by_email": null,
              "created_at": "2026-09-01T00:00:00.000Z"
            }
          ]
        }
      }
    ]
  },
  {
    "id": "demo-journey-J2",
    "key": "J2",
    "name": "Transitions and future planning",
    "description": "A family is planning for the future: transitions between schools, course\nselection, graduation pathways, work experience, support quality,\nextracurricular inclusion, and teacher accountability.",
    "detection_signals": "\"transition,\" \"moving to high school,\" \"course selection,\" \"graduation,\"\n\"credits,\" \"prerequisites,\" \"work experience,\" \"support quality,\"\n\"EA,\" \"extracurricular,\" \"future planning,\" \"what to expect,\"\n\"independence,\" \"scaffolding,\" \"learning goals,\" \"full day\"",
    "sort_order": 2,
    "is_archived": false,
    "updated_at": "2026-09-01T00:00:00.000Z",
    "updated_by_email": null,
    "prompts": {
      "detective_questions": [
        {
          "id": "seed-detective_questions-demo-journey-J2-v1",
          "field": "detective_questions",
          "owner_id": "demo-journey-J2",
          "content": "1. What school stage — elementary, middle school, entering high school,\n   in high school, post-secondary planning?\n2. What is the concern — course selection, graduation credits, transition\n   planning, EA/support effectiveness, independence and belonging,\n   learning quality, extracurricular inclusion, teacher expectations?\n3. What have they done so far — meetings, discussions with school, nothing yet?",
          "character_limit": 4000,
          "version": 1,
          "is_active": true,
          "created_by_email": null,
          "created_at": "2026-09-01T00:00:00.000Z"
        }
      ],
      "guidance": [
        {
          "id": "seed-guidance-demo-journey-J2-v1",
          "field": "guidance",
          "owner_id": "demo-journey-J2",
          "content": "For this journey, support future planning without limiting possibilities,\ntransition planning and navigation, and advocating for effective supports\nthat enable inclusion.",
          "character_limit": 6000,
          "version": 1,
          "is_active": true,
          "created_by_email": null,
          "created_at": "2026-09-01T00:00:00.000Z"
        }
      ]
    },
    "clusters": [
      {
        "id": "demo-cluster-K",
        "journey_id": "demo-journey-J2",
        "key": "K",
        "name": "Course selection and keeping options open",
        "matches_when": "Parent asks about course selection, keeping future options\navailable, graduation credits, prerequisites, or educational pathways.",
        "sort_order": 1,
        "is_archived": false,
        "updated_at": "2026-09-01T00:00:00.000Z",
        "updated_by_email": null,
        "prompts": {
          "response_pattern": [
            {
              "id": "seed-response_pattern-demo-cluster-K-v1",
              "field": "response_pattern",
              "owner_id": "demo-cluster-K",
              "content": "Response pattern:\n1. Explain how course selections influence future opportunities.\n2. Reframe: \"Which options keep the greatest number of future pathways\n   available?\" rather than \"Which courses are easiest?\"\n3. Explore the student's interests, strengths, and goals.\n4. Explain that support needs do not determine which courses a student can\n   pursue — accommodations can enable participation in a wide range of courses.\n5. Connect to graduation: explain how credits work, the difference between\n   credit-bearing and non-credit courses.\n6. For prerequisites: explain what they are, how current decisions affect\n   future eligibility, encourage understanding before deciding.\n7. For progress monitoring: help identify signs of academic difficulty early,\n   encourage regular review, suggest questions about progress and supports.\n8. Encourage keeping options open while interests develop.\n\nKey principle: \"Do not make today's decisions based solely on today's challenges.\"",
              "character_limit": 6000,
              "version": 1,
              "is_active": true,
              "created_by_email": null,
              "created_at": "2026-09-01T00:00:00.000Z"
            }
          ]
        }
      },
      {
        "id": "demo-cluster-L",
        "journey_id": "demo-journey-J2",
        "key": "L",
        "name": "Transition planning and navigation",
        "matches_when": "Parent asks about an upcoming transition, what to expect,\nwhen planning should start, what questions to ask, or what challenges\nto anticipate.",
        "sort_order": 2,
        "is_archived": false,
        "updated_at": "2026-09-01T00:00:00.000Z",
        "updated_by_email": null,
        "prompts": {
          "response_pattern": [
            {
              "id": "seed-response_pattern-demo-cluster-L-v1",
              "field": "response_pattern",
              "owner_id": "demo-cluster-L",
              "content": "Response pattern:\n1. Explain transition planning purpose and why early planning matters.\n2. Provide stage-based guidance:\n\n   Elementary to Middle School:\n   - Maintaining inclusion and belonging\n   - Preserving friendships\n   - Support continuity\n   - Maintaining learning expectations\n\n   Middle School to High School:\n   - Course selection and pathway planning\n   - Graduation planning\n   - Future opportunities\n   - Avoiding premature narrowing of options\n\n   High School to Post-Secondary/Community:\n   - Employment preparation\n   - Post-secondary options\n   - Adult services and community participation\n   - Transition-to-adulthood planning\n\n3. Identify who should be involved: family, current educators, future\n   educators, support staff, the student when appropriate.\n4. Suggest stage-appropriate questions covering: learning goals, supports,\n   inclusion and participation, future planning.\n5. Highlight commonly overlooked topics: future opportunities, social\n   inclusion, course planning (families often focus only on supports).\n6. Identify common challenges and roadblocks:\n   - Planning starts too late\n   - Information not shared between schools\n   - Expectations lowered without discussion\n   - Important stakeholders missing\n   - Pathway decisions made before alternatives explored\n7. Encourage proactive participation before decisions are finalized.\n\nThrough line: \"Help me see around corners so I can prepare before\nopportunities are lost.\"",
              "character_limit": 6000,
              "version": 1,
              "is_active": true,
              "created_by_email": null,
              "created_at": "2026-09-01T00:00:00.000Z"
            }
          ]
        }
      },
      {
        "id": "demo-cluster-M",
        "journey_id": "demo-journey-J2",
        "key": "M",
        "name": "Meaningful learning and quality education",
        "matches_when": "Parent asks about learning quality, whether their child is\nactually learning, teacher expectations, alternative pathways when\ngraduation is difficult, or quality education beyond credits.",
        "sort_order": 3,
        "is_archived": false,
        "updated_at": "2026-09-01T00:00:00.000Z",
        "updated_by_email": null,
        "prompts": {
          "response_pattern": [
            {
              "id": "seed-response_pattern-demo-cluster-M-v1",
              "field": "response_pattern",
              "owner_id": "demo-cluster-M",
              "content": "Response pattern:\n1. Explain the principle: \"Quality education includes both participation\n   AND meaningful learning, growth, and achievement.\"\n2. Help distinguish participation from educational progress.\n3. Suggest questions about learning goals, progress measurement, growth\n   evidence, and how goals connect to future opportunities.\n4. For alternative pathways: explain that graduation is one of several\n   educational outcomes. Present alternatives positively — vocational\n   training, employment preparation, community-based learning,\n   continuing education. Frame as: \"What future is my child working\n   toward?\" not \"Can my child graduate?\"\n5. For non-credit pathways: reinforce that meaningful learning includes\n   new skills, independence, relationships, interests, employment\n   preparation, community participation.\n6. For teacher expectations: encourage sharing the child's strengths,\n   interests, goals, and aspirations. Explain how expectations influence\n   opportunities and outcomes.\n7. Encourage regular review of learning goals.\n\nKey reframe: \"Credits = success\" to \"Meaningful learning = success\"\n(without minimizing the importance of graduation pathways).",
              "character_limit": 6000,
              "version": 1,
              "is_active": true,
              "created_by_email": null,
              "created_at": "2026-09-01T00:00:00.000Z"
            }
          ]
        }
      },
      {
        "id": "demo-cluster-N",
        "journey_id": "demo-journey-J2",
        "key": "N",
        "name": "Support quality and EA advocacy",
        "matches_when": "Parent asks about available supports, whether supports are\neffective, EA support, independence vs dependence, scaffolding, full-day\nparticipation with support, or monitoring support quality.",
        "sort_order": 4,
        "is_archived": false,
        "updated_at": "2026-09-01T00:00:00.000Z",
        "updated_by_email": null,
        "prompts": {
          "response_pattern": [
            {
              "id": "seed-response_pattern-demo-cluster-N-v1",
              "field": "response_pattern",
              "owner_id": "demo-cluster-N",
              "content": "Response pattern:\n1. Explain support types: accommodations, EA, communication supports,\n   personal care, transportation, behavioural supports, assistive technology,\n   environmental adaptations.\n2. Reframe from quantity to quality: \"The most important question is not\n   'What support is my child entitled to?' but 'What support does my child\n   need to participate and succeed?'\"\n3. Explain effective support indicators: meaningful participation, peer\n   engagement, educational progress, growing confidence and independence,\n   access to same opportunities as classmates.\n4. Explain warning signs: limited progress, restricted participation,\n   unnecessary dependence, reduced opportunities, limited social connections,\n   work rarely changes in complexity, support staff completing tasks for\n   the student.\n5. For independence and belonging: explain that support should help students\n   participate with peers, build friendships, make choices, and require\n   less adult prompting over time. Flag if most interactions are with adults\n   rather than peers.\n6. For scaffolding: explain as \"providing the right amount of support so a\n   student can engage in learning that might otherwise be difficult.\"\n   Balance: too little leads to frustration, too much limits growth.\n7. For full-day participation: reframe from \"can my child stay all day\" to\n   \"what supports are needed for full participation.\" Connect to learning,\n   friendships, extracurriculars, consistency.\n8. For monitoring: suggest outcome-focused check-ins rather than daily\n   oversight. Key questions: Is my child learning? Are supports working?\n   Is participation improving? Is independence increasing?\n9. For building an advocacy team: normalize involving others in meetings.\n   Identify who can help: family, advocates, professionals, the student.\n\nThrough line: \"Good supports are defined not by what is provided, but by\nthe opportunities they create.\"",
              "character_limit": 6000,
              "version": 1,
              "is_active": true,
              "created_by_email": null,
              "created_at": "2026-09-01T00:00:00.000Z"
            }
          ]
        }
      },
      {
        "id": "demo-cluster-O",
        "journey_id": "demo-journey-J2",
        "key": "O",
        "name": "Extracurricular and community inclusion",
        "matches_when": "Parent asks about field trips, clubs, sports, school events,\nafter-school activities, or inclusion beyond academics.",
        "sort_order": 5,
        "is_archived": false,
        "updated_at": "2026-09-01T00:00:00.000Z",
        "updated_by_email": null,
        "prompts": {
          "response_pattern": [
            {
              "id": "seed-response_pattern-demo-cluster-O-v1",
              "field": "response_pattern",
              "owner_id": "demo-cluster-O",
              "content": "Response pattern:\n1. Expand the concept: \"Inclusive education is about more than academics.\n   Participation, belonging, and social connection are also important.\"\n2. Provide examples: field trips, clubs, sports, assemblies, graduation\n   activities, lunch/recreation, school events.\n3. Explain why it matters: friendships, confidence, skill development,\n   community belonging, memories that shape the school experience.\n4. Suggest questions: What barriers prevent participation? What supports\n   could help? What alternatives were considered?\n5. Connect to future opportunities: employment, community participation,\n   independence, personal growth.",
              "character_limit": 6000,
              "version": 1,
              "is_active": true,
              "created_by_email": null,
              "created_at": "2026-09-01T00:00:00.000Z"
            }
          ]
        }
      }
    ]
  }
];

// Migration 028: each seeded situation gets a formatting-only cleanup of its
// steps as version 2 (version 1 stays in history, so "Go back" works in demo).
for (const journey of DEFAULT_JOURNEYS) {
  for (const cluster of journey.clusters) {
    const list = cluster.prompts.response_pattern;
    const seeded = list[0];
    if (!seeded) continue;
    list.unshift({
      ...seeded,
      id: seeded.id.replace(/-v1$/, "-v2"),
      content: cleanSteps(seeded.content),
      version: 2,
      created_at: "2026-10-01T00:00:00.000Z",
    });
    seeded.is_active = false;
  }
}
