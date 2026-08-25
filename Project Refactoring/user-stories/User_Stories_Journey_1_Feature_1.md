# USER JOURNEY 1: Involuntary Partial Day Attendance Navigation 
A child is being sent home early or placed on a reduced school schedule — not by family choice, but 
due to school limitations. This often becomes inconsistent, unpredictable, and difficult for families to 
manage.
## FEATURE 1: Guide parents through a clear, step-by-step path for what to do next
Provide a clear, structured path that guides parents through the situation from start to finish
### STORIES: 
111 - As a parent, I want the system to recognize and clearly explain my situation (e.g., partial day 
attendance) so I understand what is happening.
112 - As a parent, I want to know why my child was sent so that I can support them to receive their 
accommodations.
113 - As a parent, I want to know why my child is asked to stay home on field trip days so that my 
child can participate and I don’t have to take a day off work.
114 - As a parent, I want guidance on how to respond when the school calls to pick up my child so 
that I can take the right first step confidently and not leave work.
115 - As a parent, I want guidance on how to request the school’s decision in writing so I have 
proper documentation.
116 - As a parent, I want to know what documentation I should request from the school so that I 
have a complete picture of what’s happening.
117 - As a parent, I want to see clear next steps after each interaction with the school or other staff 
so I can keep moving forward.
118 - As a parent, I want guidance on how to prepare for and navigate conversations with the school 
so that I don’t have to take time off work to meet.
119 - As a parent, I want to understand how to ensure my child’s support plan is followed so I can 
advocate for them to remain at school full time.
11A - As a parent, I want to know what to do if the school does not respond so I can continue to 
follow up and get a response. (persistence)
11B - As a parent, I want to know what to do if the school denies my request so I can take the 
appropriate next step. (pushback) 
11C - As a parent, I want to know what to do based on the school’s response (e.g. partial 
compliance, vague response, delays) so I can continue moving forward.
11D - As a parent, I want to know how to appeal the school’s decision so I can advocate for my child 
to attend full time.
11E - As a parent, I want guidance on what to document during my conversations so I don’t lose 
important details.
11F - As a parent, I want a way to keep track of my actions so I stay organized.
11G - As a parent, I want to know when it’s time to escalate the issue so I don’t wait too long or act 
too early.
11H - As a parent, I want guidance on how to escalate if my issue isn’t resolved so I can take the 
appropriate next step.
11I - As a parent, I want to know how to involve additional support (e.g. bring someone to a 
meeting) so that I’m not alone when escalating the issue.
---
## USER STORY 111: As a parent, I want the system to recognize and clearly explain my situation (e.g., partial day attendance) so I understand what is happening. 
 
### 🟦 1. What’s the situation here? 
A parent believes their child is being placed on a reduced school schedule by the school and needs help 
understanding what is happening and why.
### 🟨 2. What does the system need to do to be helpful? 
Acceptance Criteria
The system should:
• recognize when a parent describes circumstances consistent with involuntary partial day 
attendance
• identify the situation using clear, parent-friendly language
• explain that the reduced schedule was initiated by the school rather than requested by the 
family
• explain that this is a known situation experienced by other families
• provide a brief explanation of what involuntary partial day attendance means
• reassure the parent that there are actions they can take to better understand and respond to the 
situation
• offer a logical next step within the guidance pathway
• avoid legal conclusions or assigning fault
### 🟧 3. What would the system actually say or do? 
User Flow / Conversation
Parent:
My son keeps getting sent home before lunch because the school says they can’t support him all day.
System:
1. Acknowledge the situation.
“It sounds like your child is attending school on a reduced schedule that was initiated by the 
school.”
2. Identify the situation. 
“This is often referred to as involuntary partial day attendance.”
3. Explain the situation in plain language.
“In this situation, a student attends school for less than the full day, not because the family 
requested it, but because the school believes it cannot currently support full participation.”
4. Normalize the experience.
“Many families experience this situation and are often unsure what to do next.”
5. Provide orientation.
“There are several steps you can take to better understand why this is happening and what 
options may be available.”
6. Offer the next step.
“Let’s start by understanding why the school has reduced your child’s schedule.”
### 🟥 4. What information does it need to know? 
Content Required
The system needs:
• definition of involuntary partial day attendance
• common indicators that a parent may be describing this situation
• examples of partial day attendance scenarios
• distinction between family-requested reduced schedules and school-imposed reduced 
schedules
• plain-language explanation suitable for parents
• common emotional reactions families experience
• introductory guidance on what typically happens next
• links/references to supporting inclusive education resources
### 🟪 Notes 
Estimated Complexity 
🟢 Small (1–2 days)
Why: 
• primarily recognition and explanation
• limited branching logic
• reusable pattern that will apply to many future stories
Testing Considerations 
Testers should verify that the system correctly recognizes situations such as:
• being sent home early every day
• attending only mornings
• attending only afternoons
• reduced attendance due to staffing limitations
• reduced attendance due to behavioral concerns
• reduced attendance due to lack of nursing or support resources
And that it does not incorrectly classify:
• family-requested reduced schedules
• illness-related absences
• temporary suspensions
• voluntary homeschooling 

---
## USER STORY 112: As a parent, I want to know why my child was sent home so that I can support them to receive their accommodations. 
 
### 🟦 1. What’s the situation here? 
A parent has been told their child cannot attend school for the full day and wants to understand the 
specific reasons behind the school’s decision.
### 🟨 2. What does the system need to do to be helpful? 
Acceptance Criteria 
The system should:
• help the parent identify the reason(s) provided by the school
• distinguish between observed behaviours, support needs, staffing limitations, safety concerns, 
transportation issues, and other factors
• explain the reason in plain language
• help the parent understand whether the reason relates to accommodations, supports, or school 
capacity
• identify information that may be missing or unclear
• suggest questions the parent may wish to ask the school to better understand the situation
• avoid making assumptions or assigning blame
• provide guidance that helps the parent move toward resolving the issue
### 🟧 3. What would the system actually say or do? 
User Flow / Conversation 
Parent:
The school keeps sending my daughter home after lunch because they say she can’t stay regulated for 
the full day.
System:
1. Clarify the reason.
“It sounds like the school believes your child is experiencing challenges that make it difficult to 
participate for the full school day.” 
2. Explore understanding.
“Has the school explained specifically what is happening and what supports have been tried?”
3. Explain possible categories.
“Schools often cite reasons such as behaviour, safety concerns, staffing limitations, lack of 
specialized supports, transportation challenges, or unmet accommodation needs.”
4. Help identify gaps.
“Do you know whether the school has provided this information in writing or discussed what 
accommodations were attempted before reducing attendance?”
5. Reframe toward problem-solving.
“Understanding the exact reason is important because different situations may require different 
supports, accommodations, or follow-up actions.”
6. Offer next step.
“Let’s identify what information you may still need from the school.”
### 🟥 4. What information does it need to know? 
Content Required 
The system needs:
• common reasons schools cite for reduced attendance
• examples of behaviour-related concerns
• examples of accommodation-related concerns
• examples of staffing and resource limitations
• examples of safety-related concerns
• examples of transportation-related concerns
• plain-language explanations of each category
• common questions families should ask to better understand the school’s reasoning
• information about accommodations and support plans
• indicators that the stated reason may be incomplete or unclear
### 🟪 Notes 
Estimated Complexity  
🟢 Small–Medium (1–2 days)
More complex than Story 111 because the system must:
• categorize reasons
• provide contextual explanations
• guide the parent toward gathering additional information
Testing Considerations 
Testers should verify the system responds appropriately when parents describe situations involving:
• behavioural concerns
• lack of EA support
• lack of nursing support
• safety concerns
• transportation issues
• unclear explanations from the school
• multiple contributing factors
The system should consistently:
• help clarify the reason
• avoid blame
• encourage fact-finding and documentation
• direct the parent toward the next logical step 

---
## USER STORY 113: As a parent, I want to know why my child is asked to stay home on field trip days so that my child can participate and I don’t have to take a day off work. 
 
### 🟦 1. What’s the situation here? 
A parent learns that their child’s class is going on a field trip, but their child is not being permitted to 
attend. As a result, the parent must make alternate arrangements and may need to miss work while their 
child misses an important educational and social experience.
### 🟨 2. What does the system need to do to be helpful? 
Acceptance Criteria 
The system should:
• help the parent understand the reason provided by the school for excluding the student from 
the field trip
• distinguish between support-related, safety-related, behavioural, transportation, staffing, and 
logistical concerns
• explain those reasons in plain language
• help the parent identify whether accommodations or supports have been considered
• encourage the parent to seek clarification when the reason is vague or incomplete
• help the parent understand how participation relates to inclusion
• provide questions the parent may wish to ask the school
• identify possible next steps for advocating for participation
• avoid making assumptions or legal conclusions
### 🟧 3. What would the system actually say or do? 
User Flow / Conversation 
Parent:
The school told me my son can’t attend the field trip and should stay home that day.
System:
1. Acknowledge the concern.
“It sounds like your child has been excluded from participating in a school field trip.” 
2. Seek clarification.
“Did the school explain why they believe your child cannot attend?”
3. Explore the reason.
“Schools may cite concerns related to supervision, transportation, safety, behaviour, 
accessibility, or available supports.”
4. Help identify gaps.
“Do you know whether the school explored accommodations or additional supports that could 
allow your child to participate?”
5. Connect to inclusion.
“Field trips are often considered part of a student’s educational experience, and participation 
may be important for learning, social inclusion, and belonging.”
6. Suggest questions.
“You may wish to ask what barriers were identified, what accommodations were considered, and 
what would be required for your child to participate.”
7. Offer next step.
“Let’s look at ways to gather more information and advocate for participation.”
### 🟥 4. What information does it need to know? 
Content Required 
The system needs:
• common reasons students are excluded from field trips
• examples of support and accommodation needs during community activities
• transportation considerations
• supervision and staffing considerations
• accessibility considerations
• inclusion principles related to school activities
• examples of questions parents can ask
• examples of accommodations that may support participation
• common school practices and barriers
• guidance on advocating for participation 
### 🟪 Notes 
Estimated Complexity 
🟢 Small–Medium (1–2 days)
Although similar to Story 112, this story introduces a distinct participation and inclusion context that 
warrants separate treatment.
Testing Considerations 
Testers should verify that the system appropriately responds when exclusion is attributed to:
• lack of staffing
• transportation limitations
• behavioural concerns
• safety concerns
• accessibility concerns
• lack of accommodations
• vague or unexplained decisions
The system should consistently:
• help the parent understand the reason
• encourage clarification
• connect the discussion to participation and inclusion
• identify constructive next steps 

---
## USER STORY 114: As a parent, I want guidance on how to respond when the school calls to pick up my child so that I can take the right first step confidently and not leave work. 
 
### 🟦 1. What’s the situation here? 
A parent receives a call from the school asking them to pick up their child before the end of the school 
day. The request is disruptive, may require the parent to leave work unexpectedly, and leaves them 
unsure how to respond or what questions they should ask before agreeing.
### 🟨 2. What does the system need to do to be helpful? 
Acceptance Criteria 
The system should:
• recognize when a parent is being asked to pick up their child before the end of the school day
• help the parent remain calm and gather information before responding
• guide the parent through key questions to ask the school
• help the parent understand the reason for the pickup request
• help distinguish between emergencies, safety concerns, behavioural concerns, support 
limitations, and administrative convenience
• encourage the parent to seek clarity on what supports or interventions have already been 
attempted
• help the parent understand whether the pickup is expected to be a one-time event or part of an 
emerging pattern
• suggest appropriate next steps based on the information provided
• avoid directing the parent to refuse a pickup request
• avoid providing legal advice
### 🟧 3. What would the system actually say or do? 
User Flow / Conversation 
Parent:
The school just called and wants me to come pick up my daughter.
System:
1. Acknowledge the situation. 
“I understand. Let’s gather a little more information before deciding what to do next.”
2. Clarify the reason.
“Did the school explain why they want your child picked up?”
3. Gather facts.
“Is there an immediate safety concern or emergency?”
4. Explore supports.
“Do you know what supports, accommodations, or interventions were attempted before calling 
you?”
5. Identify patterns.
“Has this happened before, or is this the first time?”
6. Help organize information.
“It may be helpful to note who called, the reason provided, and any actions the school says were 
taken.”
7. Suggest next step.
“Based on what you’ve told me, let’s look at the most appropriate next step and any questions 
you may want to ask the school.”
### 🟥 4. What information does it need to know? 
Content Required 
The system needs:
• common reasons schools request early pickup
• examples of emergency vs non-emergency situations
• behaviour-related scenarios
• safety-related scenarios
• accommodation and support-related scenarios
• staffing and resource limitation scenarios
• questions parents can ask during pickup calls
• examples of information parents should document
• indicators of a developing pattern of partial day attendance 
• guidance on responding constructively during difficult conversations
### 🟪 Notes 
Estimated Complexity 
🟢 Small–Medium (1–2 days)
The interaction is straightforward but introduces situational questioning and simple decision support.
Testing Considerations 
Testers should verify the system behaves appropriately when:
• the call involves a safety concern
• the call involves behaviour concerns
• the school reports staffing shortages
• the school reports inability to provide support
• the parent is unsure why the call is happening
• the situation has happened repeatedly
• the situation is occurring for the first time
The system should consistently:
• gather information before suggesting actions
• encourage documentation
• help the parent understand the reason for the request
• guide the parent toward the next appropriate step 

---
## USER STORY 115: As a parent, I want guidance on how to request the school’s decision in writing so I have proper documentation. 
 
### 🟦 1. What’s the situation here? 
A parent has been told verbally that their child will be sent home early or attend school on a reduced 
schedule, but nothing has been provided in writing. The parent wants to understand how to request 
written documentation so there is a clear record of the school’s decision and rationale.
### 🟨 2. What does the system need to do to be helpful? 
Acceptance Criteria 
The system should:
• explain why obtaining the decision in writing is important
• help the parent understand what information should be included in a written decision
• provide guidance on how to respectfully request the decision in writing
• offer examples of language a parent could use
• explain the difference between verbal discussions and documented decisions
• encourage the parent to maintain records of communications
• help the parent understand how written documentation may support future discussions or 
appeals
• avoid making assumptions about legal requirements or school obligations
### 🟧 3. What would the system actually say or do? 
User Flow / Conversation 
Parent:
The principal told me my son will only be attending mornings, but nothing has been provided in writing.
System:
1. Acknowledge the situation.
“It sounds like the decision has been communicated verbally, but you have not received any 
written documentation.” 
2. Explain why documentation matters.
“Having the decision in writing helps ensure everyone has a shared understanding of what was 
decided, why it was decided, and what the next steps are.”
3. Clarify what information may be helpful.
“You may wish to request the reason for the decision, the expected duration, any supports that 
were considered, and the plan for returning to full-time attendance.”
4. Provide practical guidance.
“A respectful written request is often the simplest way to obtain this information.”
5. Offer sample wording.
“For example: ‘Could you please provide the decision and the reasons for it in writing so that I 
can better understand the plan moving forward?’”
6. Encourage record keeping.
“Keeping copies of emails and written responses can be helpful if questions arise later.”
7. Suggest next step.
“Once you receive the documentation, we can review what information it contains and identify 
any gaps.”
### 🟥 4. What information does it need to know? 
Content Required 
The system needs:
• reasons families may wish to request decisions in writing
• examples of information that should be documented
• examples of respectful written requests
• sample email templates or scripts
• common elements of a school decision or attendance plan
• guidance on record keeping and documentation
• examples of missing or incomplete information
• relationship between documentation, follow-up discussions, and appeals 
### 🟪 Notes 
Estimated Complexity 
🟢 Small (1 day)
This is primarily:
• educational guidance
• simple coaching
• template-driven support
There is minimal branching logic.
Testing Considerations 
Testers should verify that the system:
• explains why written documentation is valuable
• suggests appropriate information to request
• provides respectful sample wording
• encourages record keeping
• does not imply legal rights that may vary by jurisdiction
• guides the parent toward the next step after receiving documentation 

---
## USER STORY 116: As a parent, I want to know what documentation I should request from the school so that I have a complete picture of what’s happening. 
 
### 🟦 1. What’s the situation here? 
A parent has been told that their child’s attendance will be reduced or that they are being sent home 
regularly. While they understand they should request documentation, they are unsure what information 
they should ask for in order to fully understand the school’s decision, reasoning, and plan moving 
forward.
### 🟨 2. What does the system need to do to be helpful? 
Acceptance Criteria 
The system should:
• explain the types of information that may help the parent understand the situation
• identify key documents or records that may exist
• help the parent distinguish between facts, observations, decisions, and recommendations
• suggest information that may be missing from verbal discussions
• explain why each type of documentation may be useful
• provide examples of questions the parent can ask if information is incomplete
• encourage the parent to maintain copies of all documentation received
• avoid suggesting documents that may not exist in every school or jurisdiction
### 🟧 3. What would the system actually say or do? 
User Flow / Conversation 
Parent:
The school agreed to put their decision in writing. What should I actually ask them for?
System:
1. Acknowledge the question.
“That’s a great next step. The more complete the information, the easier it will be to understand 
what is happening and what options may be available.” 
2. Explain the goal.
“You are trying to understand the decision, the reasons behind it, and the plan moving 
forward.”
3. Suggest key information to request.
“You may wish to ask for:
o the reason for the reduced schedule
o when the decision was made
o who was involved in the decision
o supports or accommodations that were attempted
o the expected duration
o the plan for returning to full-time attendance”
4. Identify additional records.
“You may also ask whether there are meeting notes, support plans, behaviour plans, or other 
documents related to the decision.”
5. Help identify gaps.
“If any of these areas are unclear, you can ask the school to clarify them.”
6. Encourage organization.
“Keeping these documents together can help you identify patterns and prepare for future 
discussions.”
7. Suggest next step.
“Once you’ve received the documentation, we can review it together and identify any missing 
information.”
### 🟥 4. What information does it need to know? 
Content Required 
The system needs:
• common documentation associated with attendance decisions
• examples of information families should request
• examples of support plans and accommodation plans 
• examples of behaviour support documentation
• examples of meeting notes and decision records
• common information gaps found in school communications
• guidance on organizing documentation
• plain-language explanations of why each document may be useful
### 🟪 Notes 
Estimated Complexity 
🟢 Small (1 day)
This is largely a guidance and information organization story.
The system is helping parents understand:
• what exists
• what to ask for
• why it matters
Testing Considerations 
Testers should verify that the system:
• identifies key categories of information parents may request
• explains why the information is useful
• suggests appropriate follow-up questions
• helps parents distinguish between decisions, observations, and recommendations
• encourages documentation and organization
• does not assume the same documents exist in all jurisdictions
Potential Future Enhancement 
This story could eventually support:
• downloadable request checklists
• documentation review workflows
• document upload and analysis 

---
## USER STORY 117: As a parent, I want to see clear next steps after each interaction with the school or other staff so I can keep moving forward. 
### 🟦 1. What’s the situation here? 
A parent has just completed a conversation with the school, received new information, or taken an 
action, but is unsure what to do next. They don’t want to lose momentum, repeat steps unnecessarily, or 
miss an important opportunity to move the situation forward.
### 🟨 2. What does the system need to do to be helpful? 
Acceptance Criteria 
The system should:
• recognize where the parent is in the partial day attendance journey
• identify the action or information that was most recently obtained
• recommend one or more logical next steps
• explain why each suggested step may be helpful
• present recommendations in plain language
• avoid overwhelming the parent with too many options
• adapt recommendations based on information already gathered
• encourage the parent to continue documenting actions and outcomes
• provide links to relevant guidance or resources where appropriate
### 🟧 3. What would the system actually say or do? 
User Flow / Conversation 
Parent:
The principal emailed me and explained why my son is only attending mornings.
System:
1. Acknowledge progress.
“That’s helpful information. You now have a better understanding of the school’s reasoning.”
2. Identify the current stage. 
“The next step is usually to understand what supports were considered before the schedule was 
reduced.”
3. Provide options.
“You may wish to:
o ask what accommodations were attempted
o request any supporting documentation
o ask what conditions would allow a return to full-time attendance”
4. Explain why.
“These questions can help you understand whether additional supports may be available.”
5. Recommend a next action.
“A good next step may be to request information about the supports that were tried before the 
decision was made.”
6. Keep momentum.
“Once you receive that information, we can determine what options may be available moving 
forward.”
### 🟥 4. What information does it need to know? 
Content Required 
The system needs:
• the overall partial day attendance pathway
• the sequence of recommended actions within the pathway
• common parent questions at each stage
• dependencies between steps
• examples of typical school responses
• decision points and branching scenarios
• supporting resources linked to each stage
• indicators that a parent may be ready for escalation or appeal
### 🟪 Notes 
⭐ Estimated Complexity – could be larger
🟡 Medium (2–3 days)
This is the first story that introduces:
• state awareness
• pathway awareness
• contextual recommendations
Unlike Stories 111–116, the system must understand where the parent is in the process before providing 
guidance.
Testing Considerations 
Testers should verify that:
• recommendations change based on information already gathered
• recommendations are relevant to the current stage
• the system does not repeatedly suggest completed actions
• the system presents manageable next steps
• the parent always receives a clear action they can take 

---
## USER STORY 118: As a parent, I want guidance on how to prepare for and navigate conversations with the school so that I can participate effectively and confidently, and avoid taking time off work to meet. 
 
### 🟦 1. What’s the situation here? 
A parent has been invited to meet with school staff to discuss their child’s reduced attendance or 
support needs. These meetings can feel intimidating, and the parent wants to be prepared so they can 
make the most of the conversation and advocate effectively for their child.
### 🟨 2. What does the system need to do to be helpful? 
Acceptance Criteria 
The system should:
• help parents prepare for discussions with school staff
• identify key information parents may wish to gather beforehand
• suggest questions parents may wish to ask during the meeting
• help parents understand the purpose of different types of school meetings
• encourage parents to document key points and decisions
• help parents identify desired outcomes before the meeting
• provide guidance for participating respectfully and confidently
• offer follow-up actions after the meeting
• support both in-person and virtual meeting scenarios
### 🟧 3. What would the system actually say or do? 
User Flow / Conversation 
Parent:
The school wants to meet with me next week about my son’s schedule. I don’t really know what to 
expect.
System:
1. Acknowledge the situation. 
“School meetings can feel overwhelming, especially when important decisions about your child’s 
education are being discussed.”
2. Clarify the purpose.
“Do you know whether this meeting is about attendance, supports, behaviour concerns, 
accommodations, or transition planning?”
3. Help the parent prepare.
“It may be helpful to think about:
o what concerns you want addressed
o what outcomes you’re hoping for
o any questions you want answered”
4. Suggest key questions.
“You may wish to ask:
o What supports have been attempted?
o What led to this recommendation?
o What would need to happen for full-time attendance to resume?”
5. Encourage documentation.
“Consider taking notes during the meeting or sending a summary afterward to confirm your 
understanding.”
6. Support advocacy.
“It’s okay to ask for clarification if something isn’t clear or if you need more information before 
making a decision.”
7. Recommend next step.
“After the meeting, we can review what was discussed and identify any follow-up actions.”
### 🟥 4. What information does it need to know? 
Content Required 
The system needs: 
• common types of school meetings
• meeting preparation guidance
• examples of effective questions parents can ask
• note-taking and documentation best practices
• examples of desired outcomes for attendance-related meetings
• guidance on communicating concerns respectfully
• follow-up email templates or examples
• common decisions that arise in attendance and accommodation discussions
### 🟪 Notes 
Estimated Complexity 
🟢 Small–Medium (1–2 days)
This is primarily a preparation and coaching story.
The complexity comes from adapting advice based on the purpose of the meeting.
Testing Considerations 
Testers should verify the system can support parents preparing for:
• attendance meetings
• behaviour-related meetings
• accommodation discussions
• support planning meetings
• follow-up meetings after attendance reductions
The system should consistently:
• help parents prepare
• suggest meaningful questions
• encourage documentation
• support respectful advocacy
• identify logical follow-up actions 

---
## USER STORY 119: As a parent, I want to understand how to ensure my child’s support plan is followed so I can advocate for them to remain at school full time. 
 
### 🟦 1. What’s the situation here? 
A parent is being told that their child cannot attend school for the full day due to behavioural, learning, 
or support-related challenges. The parent is unsure whether the accommodations, strategies, and 
supports already identified for their child are actually being implemented consistently and effectively.
### 🟨 2. What does the system need to do to be helpful? 
Acceptance Criteria 
The system should:
• help the parent understand the purpose of support plans, accommodation plans, behaviour 
plans, and IEPs
• help the parent identify what supports have been documented for their child
• explain the difference between having a plan and implementing a plan
• help the parent determine whether agreed-upon supports are being followed consistently
• suggest questions the parent can ask to better understand implementation
• help the parent identify gaps between the documented plan and current practice
• encourage constructive collaboration with the school
• explain how effective implementation of supports may affect attendance and participation
• avoid assigning blame or making assumptions about staff intentions
### 🟧 3. What would the system actually say or do? 
User Flow / Conversation 
Parent:
The school says my son can’t stay all day because of his behaviour, but he already has a behaviour 
support plan.
System:
1. Acknowledge the concern. 
“It sounds like you’re wondering whether the supports already identified for your child are being 
implemented as intended.”
2. Clarify the plan.
“Do you know what supports, accommodations, or strategies are included in your child’s 
behaviour plan or IEP?”
3. Explain the distinction.
“Having a support plan is important, but it’s also important to understand how consistently the 
plan is being followed in practice.”
4. Suggest areas to explore.
“You may wish to ask:
o Which parts of the plan are currently being implemented?
o How often are the strategies being used?
o Have any changes been made to the plan?
o What evidence suggests the plan is or isn’t working?”
5. Help identify gaps.
“If supports are not being implemented consistently, it may be difficult to determine whether 
the plan itself is effective.”
6. Connect to attendance.
“Understanding how the support plan is being used can help inform discussions about your 
child’s ability to participate in school full time.”
7. Suggest next step.
“You may wish to review the current plan and discuss implementation with the school before 
accepting a reduced schedule as the only solution.”
### 🟥 4. What information does it need to know? 
Content Required 
The system needs: 
• definitions of IEPs, accommodation plans, behaviour support plans, and related support 
documents
• examples of common accommodations and supports
• examples of behaviour support strategies
• indicators that a plan may not be implemented consistently
• questions families can ask about implementation
• examples of monitoring and review practices
• relationship between supports, participation, and attendance
• guidance on collaborative problem-solving with school teams
• examples of documenting concerns about implementation
### 🟪 Notes 
Estimated Complexity 
🟢 Small–Medium (1–2 days)
Most of the complexity is content-related rather than technical.
The system is helping parents evaluate implementation rather than providing a simple explanation.
Testing Considerations 
Testers should verify that the system can support situations where:
• a behaviour plan exists
• an IEP exists
• accommodations have been documented
• supports are inconsistently applied
• staff turnover affects implementation
• parents are unsure what supports are supposed to be in place
The system should consistently:
• focus on implementation rather than blame
• encourage fact-finding and collaboration
• help parents identify gaps between plans and practice
• connect support implementation to participation and attendance 

---
## USER STORY 11A: As a parent, I want to know what to do if the school does not respond so I can continue to follow up and get a response. (persistence). 
 
### 🟦 1. What’s the situation here? 
A parent has asked the school for information, clarification, documentation, or support, but days or 
weeks have passed without a response. They are unsure whether to wait longer, follow up again, or 
escalate the issue, and don’t want the situation to stall.
### 🟨 2. What does the system need to do to be helpful? 
Acceptance Criteria 
The system should:
• recognize when a parent has not received a response from the school
• help the parent determine whether a reasonable amount of time has passed
• explain that lack of response does not necessarily mean the issue has been rejected or resolved
• provide guidance on appropriate follow-up actions
• suggest respectful follow-up language parents can use
• help parents document follow-up attempts
• explain when additional follow-up may be appropriate
• identify situations where escalation may eventually be considered
• encourage persistence while maintaining a collaborative tone
### 🟧 3. What would the system actually say or do? 
User Flow / Conversation 
Parent:
I emailed the principal two weeks ago asking why my daughter is only attending mornings and nobody 
has replied.
System:
1. Acknowledge the frustration.
“That can be frustrating, especially when you’re trying to understand an important decision 
affecting your child.” 
2. Clarify timing.
“How long has it been since your original request, and have you sent any follow-up messages?”
3. Normalize the situation.
“In some situations, schools may be delayed in responding, but it’s reasonable to continue 
seeking clarification.”
4. Recommend a follow-up.
“A respectful follow-up message is often the next best step.”
5. Provide sample wording.
“For example:
‘I’m following up on my previous request regarding my child’s attendance. I would appreciate an 
update when you have an opportunity.’”
6. Encourage documentation.
“Keep copies of your emails and note when follow-up requests were sent.”
7. Explain future options.
“If repeated attempts do not result in a response, there may be additional steps available to 
help move the conversation forward.”
8. Suggest next step.
“Let’s review who has been contacted and determine the most appropriate follow-up.”
### 🟥 4. What information does it need to know? 
Content Required 
The system needs:
• examples of common school communication timelines
• examples of respectful follow-up language
• guidance on documenting communication attempts
• examples of communication logs
• indicators that follow-up may be appropriate
• examples of communication pathways within school systems 
• guidance on maintaining collaborative relationships during follow-up
• examples of situations where escalation may eventually be considered
### 🟪 Notes 
Estimated Complexity 
🟢 Small (1 day)
This is primarily a coaching and communication guidance story.
There is very little branching logic.
Testing Considerations 
Testers should verify the system behaves appropriately when:
• no response has been received
• only a partial response has been received
• significant time has passed
• multiple follow-ups have already occurred
• different school staff have been contacted
The system should consistently:
• encourage persistence
• suggest reasonable next actions
• support documentation
• maintain a respectful and collaborative tone
• avoid prematurely recommending escalation 

---
## USER STORY 11B: As a parent, I want to know what to do if the school denies my request so I can take the appropriate next step. (pushback). 
 
### 🟦 1. What’s the situation here? 
A parent has requested information, support, accommodations, or a return to full-time attendance, and 
the school has declined the request. The parent is disappointed and uncertain whether the decision is 
final, what it means, or what options remain available.
### 🟨 2. What does the system need to do to be helpful? 
Acceptance Criteria 
The system should:
• recognize when a parent has received a denial or rejection from the school
• help the parent understand the reason provided for the decision
• distinguish between a final decision, a temporary decision, and a request for additional 
information
• explain that a denial does not necessarily mean all options have been exhausted
• help the parent identify potential next steps
• suggest questions that may help clarify the decision
• encourage the parent to seek supporting rationale and documentation
• explain when further discussion, review, or escalation may be appropriate
• maintain a collaborative and problem-solving tone
• avoid providing legal advice or guaranteeing outcomes
### 🟧 3. What would the system actually say or do? 
User Flow / Conversation 
Parent:
I asked the school to return my daughter to full-time attendance and they said no.
System:
1. Acknowledge the situation. 
“I can understand why that would be discouraging, especially when you’re trying to ensure your 
child has access to a full school experience.”
2. Clarify the decision.
“Did the school explain why they declined the request?”
3. Explore the rationale.
“Understanding the reasons behind the decision can help determine what options may be 
available next.”
4. Identify possible next steps.
“Depending on the circumstances, you may wish to:
o request additional clarification
o ask what conditions would need to be met for the decision to change
o review supporting documentation
o discuss alternative solutions”
5. Encourage fact-finding.
“It may be helpful to understand whether the decision is considered temporary, conditional, or 
final.”
6. Discuss escalation readiness.
“If concerns remain unresolved after further discussion, there may be additional pathways 
available.”
7. Suggest next step.
“Let’s look at the reasons provided and identify the most appropriate response.”
### 🟥 4. What information does it need to know? 
Content Required 
The system needs:
• examples of common reasons schools deny requests
• examples of attendance-related decisions
• examples of accommodation and support-related decisions 
• guidance on seeking clarification
• questions parents can ask after receiving a denial
• examples of conditional versus final decisions
• communication strategies for continued discussions
• escalation pathways and prerequisites
• documentation and record-keeping guidance
### 🟪 Notes 
Estimated Complexity 
🟢 Small–Medium (1–2 days)
More nuanced than Story 11A because the system must help parents interpret and respond to a specific 
decision rather than a lack of response.
Testing Considerations 
Testers should verify the system behaves appropriately when:
• the request is denied outright
• the school provides detailed reasons
• the school provides vague reasons
• the decision is temporary
• the decision is conditional
• additional information is requested before reconsideration
The system should consistently:
• help the parent understand the rationale
• encourage clarification and documentation
• identify constructive next steps
• maintain a collaborative tone
• avoid treating the denial as the end of the process
Potential Reuse Opportunity 
This story will likely be reused throughout multiple journeys because many situations eventually reach a 
point where the parent hears: 
“No.”
Whether it’s:
• attendance,
• transitions,
• accommodations,
• extracurricular participation,
the core guidance pattern is remarkably similar:
Understand the reason → Clarify the decision → Explore options → Determine next steps. 

---
## USER STORY 11C: As a parent, I want to know what to do based on the school’s response (e.g. partial compliance, vague response, delays) so I can continue moving forward. 
 
### 🟦 1. What’s the situation here? 
A parent receives a response from the school, but the issue remains unresolved. The response may be 
vague, incomplete, delayed, or only partially address the parent’s concerns, leaving them uncertain 
about what to do next.
### 🟨 2. What does the system need to do to be helpful? 
Acceptance Criteria 
The system should:
• recognize when a school response does not fully resolve the issue
• help the parent interpret different types of responses
• distinguish between:
o partial compliance
o vague responses
o delayed actions
o requests for additional information
o commitments without timelines
• explain what information may still be missing
• suggest appropriate follow-up questions
• help the parent determine whether progress is being made
• recommend logical next steps based on the type of response received
• encourage documentation and ongoing follow-up
• avoid assuming bad intent by the school
### 🟧 3. What would the system actually say or do? 
User Flow / Conversation 
Parent:
The principal said they would review the situation and get back to me, but that was three weeks ago.
System: 
1. Acknowledge the situation.
“It sounds like the school has responded, but the issue has not yet been resolved.”
2. Clarify the response.
“Did they provide a timeline or explain what would happen next?”
3. Categorize the response.
“This may be an example of a delayed response, where some action was promised but no 
follow-up has occurred.”
4. Explain the implication.
“While the school has not denied your request, you may still need additional information before 
you know whether progress is being made.”
5. Suggest follow-up questions.
“You may wish to ask:
o Has a decision been made?
o What is the current status?
o When can I expect an update?
o Is there anything further you need from me?”
6. Encourage documentation.
“Keep a record of commitments, timelines, and follow-up conversations.”
7. Recommend next step.
“A reasonable next step would be to follow up on the commitment and request a specific 
update.”
### 🟥 4. What information does it need to know? 
Content Required 
The system needs:
• examples of common school responses
• examples of partial compliance scenarios 
• examples of vague or ambiguous responses
• examples of delayed responses
• examples of commitments without timelines
• guidance on evaluating progress
• examples of effective follow-up questions
• communication and documentation best practices
• indicators that escalation may eventually be required
### 🟪 Notes 
Estimated Complexity 
🟡 Medium (2–3 days)
This is likely the most complex story in Step 4 because there is more branching logic:
• interpret multiple response types
• identify what category the response falls into
• recommend different next steps depending on the situation
Testing Considerations 
Testers should verify the system appropriately responds when the school:
• partially fulfills a request
• provides an unclear answer
• promises future action
• requests more information
• delays a decision
• offers an alternative solution
• implements only part of a support plan
The system should consistently:
• identify the response type
• explain what it means
• identify gaps or unanswered questions
• suggest constructive next steps
• support continued progress without escalating prematurely
⭐ May recommend splitting during implementation if it becomes too large. 

---
## USER STORY 11D: As a parent, I want to know how to appeal the school’s decision so I can advocate for my child to attend full time. 
### 🟦 1. What’s the situation here? 
A parent has tried to work collaboratively with the school, sought clarification, and explored possible 
solutions, but the issue remains unresolved. They believe the school’s decision is negatively impacting 
their child and want to understand what options are available to formally challenge or review the 
decision.
### 🟨 2. What does the system need to do to be helpful? 
Acceptance Criteria
The system should:
• help the parent understand what an appeal or review process is
• explain common situations where an appeal may be appropriate
• help the parent determine whether reasonable attempts at resolution have already been made
• identify information and documentation that may support an appeal
• explain the typical stages of a review or appeal process
• help parents understand who may be involved at different levels of review
• suggest questions parents may wish to ask before initiating an appeal
• encourage organized documentation and evidence gathering
• explain that appeal processes may vary by jurisdiction
• avoid providing legal advice or guaranteeing outcomes
### 🟧 3. What would the system actually say or do? 
User Flow / Conversation 
Parent:
I’ve met with the school several times and they still won’t return my son to full-time attendance. What do 
I do now?
System:
1. Acknowledge the situation. 
“It sounds like you’ve made several attempts to resolve the issue and still have significant 
concerns about the decision.”
2. Assess readiness.
“Have you received the school’s decision and rationale in writing, and have you had an 
opportunity to discuss your concerns with the school team?”
3. Explain the purpose of an appeal.
“An appeal or review process is typically used when a parent believes a decision should be 
reconsidered and normal discussions have not resolved the issue.”
4. Identify preparation steps.
“Before proceeding, it may be helpful to organize:
o meeting notes
o written decisions
o emails and correspondence
o support plans and relevant documentation”
5. Explain the process.
“Appeal processes vary, but often involve a review by another level within the education 
system.”
6. Encourage informed action.
“Understanding the process and preparing your information can help you advocate more 
effectively.”
7. Suggest next step.
“Let’s identify what documentation you already have and what information may still be missing.”
### 🟥 4. What information does it need to know? 
Content Required 
The system needs:
• plain-language explanation of appeals and reviews
• common reasons families seek appeals 
• examples of attendance-related disputes
• examples of documentation that may support an appeal
• escalation pathways within education systems
• examples of evidence and records families may gather
• communication templates and preparation guidance
• jurisdiction-specific appeal information where available
• guidance on organizing information and timelines
### 🟪 Notes 
Estimated Complexity 
🟡 Medium (2–3 days)
This story introduces:
• escalation concepts
• process navigation
• jurisdictional variation
The guidance must remain high-level enough to work broadly while still being useful.
Testing Considerations 
Testers should verify the system behaves appropriately when:
• the parent has attempted multiple discussions
• written decisions have been received
• documentation exists
• documentation is incomplete
• the parent is considering escalation for the first time
• the parent is unsure whether appeal is appropriate
The system should consistently:
• explain appeals in plain language
• help parents assess readiness
• identify supporting documentation
• encourage preparation and organization
• avoid legal advice
• avoid positioning appeals as adversarial 

---
## USER STORY 11E: As a parent, I want guidance on what to document during my conversations so I don’t lose important details. 
### 🟦 1. What’s the situation here? 
A parent is having conversations with teachers, principals, support staff, or school administrators about 
their child’s attendance and supports. Important information is being shared, but the parent is worried 
they may forget key details, misunderstand what was agreed to, or lose track of commitments made 
during the discussion.
### 🟨 2. What does the system need to do to be helpful? 
Acceptance Criteria 
The system should:
• explain why documenting conversations is important
• help parents identify what information is most useful to record
• suggest a simple structure for documenting conversations
• distinguish between facts, opinions, commitments, and decisions
• encourage documentation of timelines, responsibilities, and next steps
• provide examples of useful notes parents can take
• help parents organize information for future discussions
• encourage timely documentation while details are still fresh
• avoid encouraging adversarial or excessive record-keeping
### 🟧 3. What would the system actually say or do? 
User Flow / Conversation 
Parent:
I have a meeting with the school tomorrow. What should I be writing down?
System:
1. Explain the purpose.
“Good documentation can help you remember what was discussed, what decisions were made, 
and what actions are expected moving forward.” 
2. Suggest key information to record.
“You may wish to note:
o date and time
o who attended
o concerns discussed
o decisions made
o commitments or promises
o timelines mentioned
o next steps”
3. Highlight common gaps.
“Many parents remember the discussion but later forget who agreed to do what or when follow-up was expected.”
4. Encourage clarity.
“If something is unclear during the conversation, it may be helpful to ask for clarification before 
the meeting ends.”
5. Support organization.
“Keeping your notes together with emails and other documents can make future discussions 
much easier.”
6. Suggest follow-up.
“After the meeting, you may wish to send a short summary email confirming your understanding 
of the discussion.”
7. Recommend next step.
“Let’s review a simple conversation log template you can use.”
### 🟥 4. What information does it need to know? 
Content Required 
The system needs:
• best practices for documenting meetings and conversations
• examples of conversation logs 
• examples of useful meeting notes
• guidance on documenting commitments and timelines
• examples of follow-up summaries
• documentation templates or checklists
• common information parents forget to record
• organization and record-keeping strategies
### 🟪 Notes 
Estimated Complexity 
🟢 Small (1 day)
This is primarily a guidance and organization story with very little branching logic.
The value comes from helping parents consistently capture information that may become important 
later.
Testing Considerations 
Testers should verify the system:
• identifies important information to document
• suggests a practical note-taking structure
• distinguishes decisions from discussions
• encourages documenting timelines and commitments
• supports organization of information
• recommends follow-up summaries where appropriate
The system should consistently help parents create records that would be useful in:
• future meetings
• follow-up discussions
• appeals
• escalation processes
• support plan reviews
Potential Reuse Opportunity 
This story has strong overlap with: 
• Story 115 (requesting decisions in writing)
• Story 116 (requesting documentation)
• Story 11A (following up when there is no response)
• Story 11D (appeal preparation)
Together, these stories are forming a broader capability around:
Documentation and evidence gathering
which is emerging as a recurring theme across the entire journey. 

---
## USER STORY 11F: As a parent, I want a way to keep track of my actions so I stay organized. 
### 🟦 1. What’s the situation here? 
A parent has had multiple conversations, sent emails, attended meetings, and taken various actions to 
support their child, but is struggling to keep track of what has already been done, what is still 
outstanding, and what should happen next.
### 🟨 2. What does the system need to do to be helpful? 
Acceptance Criteria 
The system should:
• help parents record actions they have taken
• allow parents to track progress over time
• distinguish between completed actions, pending actions, and future actions
• help parents identify outstanding follow-ups
• provide a simple way to organize activities chronologically
• support documentation of key dates and milestones
• help parents understand where they are in the process
• make it easy to review previous actions before meetings or discussions
• encourage ongoing organization without creating excessive administrative burden
### 🟧 3. What would the system actually say or do? 
User Flow / Conversation 
Parent:
I’ve sent emails, talked to the principal, requested documentation, and attended meetings. I’m starting 
to lose track of everything.
System:
1. Acknowledge the challenge.
“That’s very common. When situations unfold over weeks or months, it can become difficult to 
remember what has already happened.”
2. Explain the benefit. 
“Keeping track of your actions can help you stay organized, avoid repeating steps, and prepare for 
future discussions.”
3. Suggest categories.
“You may wish to track:
o emails sent
o meetings attended
o documentation requested
o responses received
o follow-up actions
o upcoming commitments”
4. Organize chronologically.
“Recording actions in date order can help create a clear timeline of events.”
5. Identify gaps.
“Reviewing your timeline may help identify unanswered questions or overdue follow-ups.”
6. Support future planning.
“Before your next meeting, you can quickly review what actions have already been taken.”
7. Recommend next step.
“Let’s create a simple action log that tracks what you’ve done and what still needs attention.”
### 🟥 4. What information does it need to know? 
Content Required 
The system needs:
• examples of action tracking logs
• timeline and case management best practices
• examples of completed versus outstanding actions
• guidance on organizing communication records
• examples of milestone tracking
• templates for action plans and follow-up logs
• examples of common activities parents undertake during advocacy processes
• strategies for maintaining organized records over time 
### 🟪 Notes 
Estimated Complexity 
🟢 Small–Medium (1–2 days)
If implemented as guidance only:
• Small
If implemented with action tracking capability:
• Medium
The team will need to determine whether Version 1 simply teaches parents how to track actions or 
actually stores and manages those actions.
Testing Considerations 
Testers should verify the system:
• helps parents identify actions already taken
• distinguishes completed and pending actions
• encourages chronological organization
• supports preparation for future meetings
• helps identify missing follow-ups
• provides a simple and understandable structure
The system should consistently help parents answer:
“What have I already done?”
“What’s still outstanding?”
“What’s my next step?” 

---
## USER STORY 11G: As a parent, I want to know when it’s time to escalate the issue so I don’t wait too long or act too early. 
### 🟦 1. What’s the situation here? 
A parent has been working with the school to resolve concerns about their child’s reduced attendance, 
but progress has stalled. They are unsure whether they should continue trying to resolve the issue 
through normal discussions or whether it is time to involve additional people, processes, or supports.
### 🟨 2. What does the system need to do to be helpful? 
Acceptance Criteria 
The system should:
• help the parent assess the current state of the situation
• identify indicators that the issue may not be progressing toward resolution
• distinguish between situations that may benefit from continued discussion and those that may 
warrant escalation
• help the parent evaluate whether reasonable attempts have been made to resolve the issue
• explain common signs that additional support or review may be needed
• encourage documentation of previous actions and outcomes
• help parents understand the purpose of escalation
• provide guidance without encouraging premature escalation
• avoid assuming bad intent by the school or staff
### 🟧 3. What would the system actually say or do? 
User Flow / Conversation 
Parent:
We’ve had three meetings and my son is still only attending mornings. How do I know if it’s time to 
escalate?
System:
1. Acknowledge the concern.
“That’s a reasonable question. Many parents struggle to determine when continued discussions 
are likely to be productive and when additional support may be needed.” 
2. Explore what has already happened.
“Let’s look at what actions have already been taken and what responses you’ve received.”
3. Assess progress.
“Have any meaningful changes occurred since the issue was first identified?”
4. Identify indicators.
“Some signs that escalation may be appropriate include:
o repeated meetings without progress
o commitments that are not being followed through
o lack of response to requests
o unresolved concerns despite multiple attempts to address them”
5. Explain the purpose.
“Escalation is typically intended to bring additional review, support, or decision-making into the 
process when normal discussions have not resolved the issue.”
6. Encourage thoughtful action.
“The goal is not to escalate at the first challenge, but also not to allow concerns to remain 
unresolved indefinitely.”
7. Suggest next step.
“Let’s review your timeline and determine whether escalation may be appropriate in your 
situation.”
### 🟥 4. What information does it need to know? 
Content Required 
The system needs:
• common indicators that escalation may be appropriate
• examples of situations where continued discussion may still be productive
• examples of unresolved attendance-related concerns
• escalation principles and decision-making guidance
• examples of communication breakdowns
• examples of unmet commitments or stalled progress 
• documentation and timeline review guidance
• examples of escalation pathways within education systems
### 🟪 Notes 
Estimated Complexity 
🟢 Small–Medium (1–2 days)
This story is primarily a coaching and assessment story.
The system is helping parents evaluate their situation rather than directing a specific action.
Testing Considerations 
Testers should verify the system appropriately responds when:
• discussions are ongoing and productive
• discussions have stalled
• commitments have not been fulfilled
• responses are delayed
• multiple meetings have occurred without progress
• parents are uncertain whether escalation is warranted
The system should consistently:
• help assess readiness
• identify indicators objectively
• encourage thoughtful decision-making
• avoid escalating unnecessarily
• connect recommendations to documented facts and actions 

---
## USER STORY 11H: As a parent, I want guidance on how to escalate if my issue isn’t resolved so I can take the appropriate next step. 
### 🟦 1. What’s the situation here? 
A parent has made multiple attempts to resolve concerns about their child’s reduced attendance, but 
the issue remains unresolved. They believe additional support or review is needed and want guidance 
on how to move the issue forward appropriately.
### 🟨 2. What does the system need to do to be helpful? 
Acceptance Criteria 
The system should:
• help the parent understand common escalation options
• explain the purpose of escalation and when it may be appropriate
• help parents identify potential next steps based on their situation
• explain the importance of documentation and preparation before escalating
• help parents organize information that may support escalation
• provide guidance on communicating concerns clearly and respectfully
• explain that escalation pathways may vary by jurisdiction
• encourage constructive problem-solving throughout the process
• avoid recommending a specific escalation pathway without sufficient context
• avoid providing legal advice
### 🟧 3. What would the system actually say or do? 
User Flow / Conversation 
Parent:
I’ve tried meetings, follow-ups, and discussions with the school. Nothing has changed. What should I do 
next?
System:
1. Acknowledge the situation.
“It sounds like you’ve made several attempts to resolve the issue and are looking for additional 
ways to move the conversation forward.” 
2. Review what’s been done.
“Before considering escalation, let’s review what actions you’ve already taken and what 
responses you’ve received.”
3. Explain escalation.
“Escalation generally means involving additional people, supports, or review processes when 
normal discussions have not resolved the issue.”
4. Explore options.
“Depending on your situation, options may include:
o requesting a higher-level review
o seeking advocacy support
o involving additional school or district personnel
o pursuing a formal review or appeal process”
5. Emphasize preparation.
“Having clear documentation and a timeline of events can make escalation discussions more 
effective.”
6. Encourage constructive communication.
“The goal is usually to bring additional attention, support, or decision-making to the issue rather 
than to create conflict.”
7. Suggest next step.
“Let’s identify which escalation options may be most appropriate based on your situation.”
### 🟥 4. What information does it need to know? 
Content Required 
The system needs:
• common escalation pathways within education systems
• examples of escalation scenarios
• guidance on preparing for escalation
• documentation and timeline review guidance
• examples of advocacy supports and resources 
• communication best practices
• examples of formal and informal escalation approaches
• jurisdiction-specific escalation information where available
• relationship between escalation, review, and appeal processes
### 🟪 Notes 
Estimated Complexity 
🟢 Small–Medium (1–2 days)
The story is primarily educational and process-oriented.
Unlike 11D, the focus is not a formal appeal process but helping parents understand the broader 
concept of escalation and available pathways.
Testing Considerations 
Testers should verify the system:
• explains escalation in plain language
• helps parents assess available options
• encourages documentation and preparation
• maintains a collaborative tone
• distinguishes escalation from appeal
• avoids legal advice
• adapts guidance based on actions already taken
The system should consistently help parents answer:
“What are my options now?”
rather than:
“Which option should I take?” 

---
## USER STORY 11I: As a parent, I want to know how to involve additional support (e.g. bring someone to a meeting) so that I’m not alone when escalating the issue. 
 
### 🟦 1. What’s the situation here? 
A parent is preparing for a difficult conversation, review, or escalation process involving their child’s 
education. They feel overwhelmed by the situation and would like support from someone they trust so 
they don’t have to navigate the process alone.
### 🟨 2. What does the system need to do to be helpful? 
Acceptance Criteria 
The system should:
• explain the value of involving additional support during difficult discussions
• help parents identify potential sources of support
• explain different roles supporters may play
• provide guidance on preparing supporters before meetings
• help parents determine when additional support may be beneficial
• encourage collaborative and respectful participation
• explain how supporters can help with note-taking, advocacy, emotional support, and follow-up
• reassure parents that seeking support is a normal part of advocacy
• avoid positioning supporters as adversaries to the school
### 🟧 3. What would the system actually say or do? 
User Flow / Conversation 
Parent:
I have another meeting with the school next week and honestly, I don’t want to go by myself.
System:
1. Acknowledge the concern.
“Many parents feel that way, especially when conversations involve important decisions about 
their child’s education.” 
2. Normalize support.
“You do not necessarily have to navigate these discussions alone.”
3. Explore support options.
“Some parents choose to bring:
o a spouse or family member
o a friend they trust
o an advocate
o a community support person
o someone who can help take notes”
4. Explain potential benefits.
“Having another person present can help you remember information, ask questions, provide 
emotional support, and help you stay focused during the discussion.”
5. Encourage preparation.
“It may be helpful to discuss your goals and concerns with your support person before the 
meeting.”
6. Reframe the purpose.
“The goal is not to create conflict, but to ensure you feel supported and able to participate 
effectively.”
7. Suggest next step.
“Let’s think about who in your network might be able to support you.”
### 🟥 4. What information does it need to know? 
Content Required 
The system needs:
• examples of support people families commonly involve
• roles supporters can play during meetings
• meeting preparation guidance
• examples of advocacy support resources
• note-taking and documentation support practices 
• emotional support considerations
• examples of collaborative participation approaches
• guidance on communicating with support people before meetings
### 🟪 Notes 
Estimated Complexity 
🟢 Small (1 day)
This is primarily a coaching and confidence-building story.
There is minimal branching logic and the content is highly reusable across multiple journeys.
Testing Considerations 
Testers should verify the system:
• normalizes seeking support
• identifies multiple types of supporters
• explains how supporters can help
• encourages preparation and collaboration
• avoids adversarial language
• reinforces the parent’s role in decision-making
The system should consistently help parents answer:
“Who can help me carry this?”
rather than:
“How do I fight this battle alone?” 
