# User Stories - Journey 1 Feature 1

USER JOURNEY 1: Involuntary Partial Day Attendance Navigation
A child is being sent home early or placed on a reduced school schedule — not by family choice, but
due to school limitations.

FEATURE 1: Guide parents through a clear, step-by-step path for what to do next
Provide a clear, structured path that guides parents through the situation from start to finish

STORIES:
111 - As a parent, I want the system to recognize and clearly explain my situation (e.g., partial day
attendance) so I understand what is happening.
114 - As a parent, I want guidance on how to respond when the school calls to pick up my child so
that I can take the right first step confidently and not leave work.
11A - As a parent, I want to know what to do if the school does not respond so I can continue to
follow up and get a response. (persistence)

*****

USER STORY 111: As a parent, I want the system to recognize and clearly explain my situation
(e.g., partial day attendance) so I understand what is happening.

🟦 1. What’s the situation here?

A parent believes their child is being placed on a reduced school schedule by the school and needs help
understanding what is happening and why.

🟨 2. What does the system need to do to be helpful?
Acceptance Criteria

The system should:
• recognize when a parent describes circumstances consistent with involuntary partial day
attendance
• identify the situation using clear, parent-friendly language
• avoid legal conclusions or assigning fault

🟧 3. What would the system actually say or do?
User Flow / Conversation
Parent:

My son keeps getting sent home before lunch because the school says they can’t support him all day.
System:

1. Acknowledge the situation.
“It sounds like your child is attending school on a reduced schedule that was initiated by the
school.”
2. Identify the situation.

“This is often referred to as involuntary partial day attendance.”
3. Offer the next step.
“Let’s start by understanding why the school has reduced your child’s schedule.”

🟥 4. What information does it need to know?
Content Required

The system needs:
• definition of involuntary partial day attendance
• plain-language explanation suitable for parents

🟪 Notes
Estimated Complexity
🟢 Small (1–2 days)

Why:

•
•

primarily recognition and explanation
limited branching logic

Testing Considerations
Testers should verify that the system correctly recognizes situations such as:
•
•
•

being sent home early every day
attending only mornings
reduced attendance due to lack of nursing or support resources

And that it does not incorrectly classify:
•
•

family-requested reduced schedules
temporary suspensions

User Story 114: As a parent, I want guidance on how to respond when the school calls to pick
up my child so that I can take the right first step confidently and not leave work.

🟦 1. What’s the situation here?

A parent receives a call from the school asking them to pick up their child before the end of the school
day.

🟨 2. What does the system need to do to be helpful?

Acceptance Criteria
The system should:
•
•
•
•

recognize when a parent is being asked to pick up their child before the end of the school day
help the parent remain calm and gather information before responding
help distinguish between emergencies, safety concerns, behavioural concerns, support
limitations, and administrative convenience
avoid providing legal advice

🟧 3. What would the system actually say or do?

User Flow / Conversation
Parent:

The school just called and wants me to come pick up my daughter.
System:

1. Acknowledge the situation.

“I understand. Let’s gather a little more information before deciding what to do next.”
2. Suggest key information to request.
“You may wish to ask for:
o
o

the reason for the request
whether this has happened before”

🟥 4. What information does it need to know?

Content Required
The system needs:
•
•

common reasons schools request early pickup
questions parents can ask during pickup calls

•

guidance on responding constructively during difficult conversations

🟪 Notes
Estimated Complexity

🟢 Small–Medium (1–2 days)

The interaction is straightforward but introduces situational questioning and simple decision support.
Testing Considerations

Testers should verify the system behaves appropriately when:
•
•

the call involves a safety concern
the situation has happened repeatedly

The system should consistently:
•
•

gather information before suggesting actions
encourage documentation

USER STORY 11A: As a parent, I want to know what to do if the school does not respond so I can
continue to follow up and get a response. (persistence)

🟦 1. What’s the situation here?

A parent has asked the school for information and has heard nothing back.

🟨 2. What does the system need to do to be helpful?

Acceptance Criteria

The system should:
•
•

suggest a respectful follow-up
encourage the parent to keep a record of every request

🟧 3. What would the system actually say or do?

User Flow / Conversation
Parent:

I emailed the principal two weeks ago and still have not heard back.
System:

1. Acknowledge the frustration.
“Waiting without a reply is hard.”

🟪 Notes

Testing Considerations

Testers should verify the system:
•
•

suggests a follow-up message
encourages record keeping

The system should consistently help parents answer:
“What can I do when the school does not reply?”

rather than:
“Who is to blame for the silence?”

Potential Future Enhancement

This story could eventually support:
•

reminder scheduling
