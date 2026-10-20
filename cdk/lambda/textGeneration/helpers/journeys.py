"""
journeys.py

Journey and situation-cluster catalog.

Admins manage journeys (for example J1 "Involuntary partial day attendance")
and the situation clusters inside each journey (for example C "Responding in
the moment") in the journeys / journey_clusters / journey_prompt_versions
tables (migration 024). This module:

  - holds the catalog data types and DEFAULT_CATALOG, the fallback used when
    the tables are missing or empty (it mirrors the migration 024 seed;
    tests/test_prompt_sync.py checks they match),
  - builds a catalog from database rows,
  - picks the journeys and clusters that apply to a routed turn, and
  - renders the <journeys> prompt blocks for the detective and suggestion
    phases.

Only the routed journey and clusters are sent on guidance turns. When routing
is unclear (no route, journey UNCLEAR/BOTH and no known cluster) every active
journey and cluster is included, which matches the pre-024 behaviour.

Keys are short upper-case identifiers stored in session metadata, so they are
immutable once created. BOTH, UNCLEAR, UNKNOWN and NONE are reserved by the
router.
"""

import re
from dataclasses import dataclass, replace
from typing import Any, Iterable, List, Optional, Sequence, Tuple

KEY_PATTERN = re.compile(r"^[A-Z0-9_]{1,16}$")

JOURNEY_BOTH = "BOTH"
JOURNEY_UNCLEAR = "UNCLEAR"
SITUATION_UNKNOWN = "UNKNOWN"
SITUATION_NONE = "NONE"
RESERVED_KEYS = frozenset({JOURNEY_BOTH, JOURNEY_UNCLEAR, SITUATION_UNKNOWN, SITUATION_NONE})

FIELD_DETECTIVE_QUESTIONS = "detective_questions"
FIELD_GUIDANCE = "guidance"
FIELD_RESPONSE_PATTERN = "response_pattern"

_RULE = "=" * 67


def is_valid_key(value: Any) -> bool:
    return isinstance(value, str) and bool(KEY_PATTERN.match(value)) and value not in RESERVED_KEYS


def _one_line(text: str) -> str:
    return " ".join((text or "").split())


def _indent(text: str, prefix: str = "  ") -> str:
    return "\n".join(f"{prefix}{line}" if line.strip() else "" for line in text.splitlines())


# ------------------------------------------------------------------
# Data types
# ------------------------------------------------------------------

@dataclass(frozen=True)
class Cluster:
    key: str
    name: str
    matches_when: str
    response_pattern: str
    sort_order: int = 0


@dataclass(frozen=True)
class Journey:
    key: str
    name: str
    description: str
    detection_signals: str
    detective_questions: str
    guidance: str
    clusters: Tuple[Cluster, ...] = ()
    sort_order: int = 0


@dataclass(frozen=True)
class JourneyCatalog:
    journeys: Tuple[Journey, ...] = ()

    @property
    def is_empty(self) -> bool:
        return not self.journeys

    @property
    def journey_keys(self) -> frozenset:
        return frozenset(j.key for j in self.journeys)

    @property
    def cluster_keys(self) -> frozenset:
        return frozenset(c.key for j in self.journeys for c in j.clusters)

    def journey(self, key: Optional[str]) -> Optional[Journey]:
        for j in self.journeys:
            if j.key == key:
                return j
        return None

    def owner_of(self, cluster_key: Optional[str]) -> Optional[Journey]:
        for j in self.journeys:
            if any(c.key == cluster_key for c in j.clusters):
                return j
        return None


def catalog_from_rows(rows: Iterable[Sequence[Any]]) -> JourneyCatalog:
    """
    Build a catalog from crud.fetch_journey_catalog rows, already ordered by
    journey sort order then cluster sort order. Each row is:

      (journey_key, journey_name, description, detection_signals, journey_sort,
       detective_questions, guidance,
       cluster_key, cluster_name, matches_when, cluster_sort, response_pattern)

    Cluster columns are NULL for a journey without clusters (LEFT JOIN).
    Rows with invalid keys are skipped.
    """
    order: List[str] = []
    heads = {}
    clusters = {}
    for row in rows:
        (j_key, j_name, j_desc, j_signals, j_sort, j_questions, j_guidance,
         c_key, c_name, c_matches, c_sort, c_pattern) = row
        if not is_valid_key(j_key):
            continue
        if j_key not in heads:
            order.append(j_key)
            heads[j_key] = dict(
                key=j_key,
                name=j_name or j_key,
                description=j_desc or "",
                detection_signals=j_signals or "",
                detective_questions=j_questions or "",
                guidance=j_guidance or "",
                sort_order=int(j_sort or 0),
            )
            clusters[j_key] = []
        if is_valid_key(c_key) and all(c.key != c_key for c in clusters[j_key]):
            clusters[j_key].append(Cluster(
                key=c_key,
                name=c_name or c_key,
                matches_when=c_matches or "",
                response_pattern=c_pattern or "",
                sort_order=int(c_sort or 0),
            ))
    return JourneyCatalog(tuple(
        Journey(clusters=tuple(clusters[k]), **heads[k]) for k in order
    ))


# ------------------------------------------------------------------
# Selection
# ------------------------------------------------------------------

def _route_keys(route: Any) -> Tuple[str, List[str]]:
    if route is None:
        return JOURNEY_UNCLEAR, []
    journey = getattr(route, "journey", JOURNEY_UNCLEAR) or JOURNEY_UNCLEAR
    clusters: List[str] = []
    for key in (getattr(route, "situation", None), getattr(route, "secondary_situation", None)):
        if key and key not in clusters:
            clusters.append(key)
    return journey, clusters


def select_for_route(catalog: JourneyCatalog, route: Any) -> List[Tuple[Journey, List[Cluster]]]:
    """
    Journeys (catalog order) with the clusters to include for this route.

      - known primary/secondary clusters -> just those clusters, under their
        journeys, plus the routed journey's guidance if it is a different one
      - known journey, no known cluster  -> that journey with all its clusters
      - otherwise (UNCLEAR, BOTH, no route) -> every journey and cluster
    """
    journey_key, cluster_keys = _route_keys(route)
    known_clusters = [k for k in cluster_keys if k in catalog.cluster_keys]

    if not known_clusters:
        routed = catalog.journey(journey_key)
        if routed is not None:
            return [(routed, list(routed.clusters))]
        return [(j, list(j.clusters)) for j in catalog.journeys]

    selected_journeys = {catalog.owner_of(k).key for k in known_clusters}
    if catalog.journey(journey_key) is not None:
        selected_journeys.add(journey_key)
    return [
        (j, [c for c in j.clusters if c.key in known_clusters])
        for j in catalog.journeys
        if j.key in selected_journeys
    ]


def focus_journey(catalog: JourneyCatalog, route: Any) -> Optional[Journey]:
    """The single journey a detective turn should focus on, if one is known."""
    journey_key, cluster_keys = _route_keys(route)
    routed = catalog.journey(journey_key)
    if routed is not None:
        return routed
    if journey_key == JOURNEY_BOTH:
        return None
    owners = {catalog.owner_of(k).key for k in cluster_keys if k in catalog.cluster_keys}
    if len(owners) == 1:
        return catalog.journey(owners.pop())
    return None


def seen_keys(catalog: JourneyCatalog, route: Any) -> Tuple[List[str], List[str]]:
    """
    Journey and cluster keys this route touched, for feedback analytics.
    A cluster also counts toward the journey that owns it.
    """
    journey_key, cluster_keys = _route_keys(route)
    clusters = [k for k in cluster_keys if k in catalog.cluster_keys]
    journeys: List[str] = []
    if journey_key in catalog.journey_keys:
        journeys.append(journey_key)
    for k in clusters:
        owner = catalog.owner_of(k).key
        if owner not in journeys:
            journeys.append(owner)
    return journeys, clusters


# ------------------------------------------------------------------
# Rendering
# ------------------------------------------------------------------

def _journey_header(journey: Journey) -> str:
    return f"{_RULE}\nJOURNEY {journey.key} — {journey.name.upper()}\n{_RULE}"


def render_cluster(cluster: Cluster) -> str:
    parts = [f"SITUATION {cluster.key} — {cluster.name.upper()}"]
    if cluster.matches_when.strip():
        parts.append(f"Matches when: {_one_line(cluster.matches_when)}")
    text = "\n".join(parts)
    if cluster.response_pattern.strip():
        text += f"\n\n{cluster.response_pattern.strip()}"
    return text


def build_suggestion_block(catalog: JourneyCatalog, route: Any) -> str:
    """<journeys> block for SUGGESTION/PARTIAL turns. Empty if the catalog is."""
    selection = select_for_route(catalog, route)
    if not selection:
        return ""
    parts = []
    for journey, clusters in selection:
        section = [_journey_header(journey)]
        if journey.guidance.strip():
            section.append(journey.guidance.strip())
        section.extend(render_cluster(c) for c in clusters)
        parts.append("\n\n".join(section))
    return "<journeys>\n" + "\n\n".join(parts) + "\n</journeys>"


def build_journey_list(catalog: JourneyCatalog) -> str:
    """
    <supported_journeys> block appended to the role on every turn: one line
    per active journey (key, name and description). Route-independent, so the
    static prompt block stays cacheable. Empty if the catalog is.
    """
    if catalog.is_empty:
        return ""
    lines = []
    for journey in catalog.journeys:
        line = f"{journey.key} — {journey.name}"
        if journey.description.strip():
            line += f": {_one_line(journey.description)}"
        lines.append(line)
    return "<supported_journeys>\n" + "\n".join(lines) + "\n</supported_journeys>"


def apply_document_coverage(catalog: JourneyCatalog, coverage: dict) -> JourneyCatalog:
    """
    Journeys with ready documents stop pasting their question list and journey
    guidance. A situation whose name matches a document section also drops its
    typed steps. Situations the documents do not cover keep their steps.
    """
    if not coverage or catalog.is_empty:
        return catalog
    journeys = []
    for journey in catalog.journeys:
        info = coverage.get(journey.key)
        if not info:
            journeys.append(journey)
            continue
        names = info.get("names") or set()
        clusters = tuple(
            replace(cluster, response_pattern="")
            if _one_line(cluster.name).casefold() in names
            else cluster
            for cluster in journey.clusters
        )
        journeys.append(replace(
            journey,
            detective_questions="",
            guidance="",
            clusters=clusters,
        ))
    return JourneyCatalog(tuple(journeys))


def build_detective_block(catalog: JourneyCatalog, route: Any, outlines: Optional[dict] = None) -> str:
    """
    <journeys> block for DETECTIVE turns: every journey's description, signals
    and cluster index (so the journey can be identified), plus the detective
    questions for the focused journey, or for every journey if none is known.
    """
    if catalog.is_empty:
        return ""
    focus = focus_journey(catalog, route)
    sections = []
    for journey in catalog.journeys:
        lines = [f"JOURNEY {journey.key} — {journey.name}"]
        if journey.description.strip():
            lines.append(_indent(journey.description.strip()))
        if journey.detection_signals.strip():
            lines.append("  Signals:")
            lines.append(_indent(journey.detection_signals.strip(), "    "))
        if journey.clusters:
            index = "; ".join(f"{c.key} {c.name}" for c in journey.clusters)
            lines.append(f"  Situations: {index}")
        if (focus is None or focus.key == journey.key) and journey.detective_questions.strip():
            lines.append("  Questions to ask (in this order if unknown):")
            lines.append(_indent(journey.detective_questions.strip(), "    "))
        outline = (outlines or {}).get(journey.key)
        if outline:
            lines.append(outline)
        sections.append("\n".join(lines))
    return "<journeys>\n" + "\n\n".join(sections) + "\n</journeys>"


# ------------------------------------------------------------------
# Default catalog (mirrors the migration 024 seed)
# ------------------------------------------------------------------

def _t(text: str) -> str:
    return text.strip()


DEFAULT_CATALOG = JourneyCatalog((
    Journey(
        key="J1",
        name="Involuntary partial day attendance",
        sort_order=1,
        description=_t("""
A child is being excluded or placed on a reduced school schedule:
involuntary partial day attendance, field trip exclusion, early pickups,
reduced hours.
"""),
        detection_signals=_t("""
"sent home," "reduced schedule," "can't attend," "only mornings/afternoons,"
"field trip excluded," "pick up early," "partial day," "school called,"
"can't support," "stay home," "not allowed to participate"
"""),
        detective_questions=_t("""
1. What is happening — sent home early, excluded from field trips/activities,
   reduced hours, school calling to pick up, support plan not followed?
2. How long / how often — just started or ongoing pattern?
3. What have they tried — nothing yet, verbal contact, requested written
   documentation, attended meetings, received denial, considering escalation?
4. What do they need most — understanding the situation, getting documentation,
   preparing for a meeting, understanding rights, knowing when to escalate,
   support at a meeting, follow-up after no response?
"""),
        guidance=_t("""
For this journey, give step-by-step guidance, plain-language explanations
of key concepts, and rights-based advocacy support.
"""),
        clusters=(
            Cluster(
                key="A",
                name="Recognizing and understanding the situation",
                sort_order=1,
                matches_when=_t("""
Parent describes a child being sent home early, attending only
part of the day, excluded from activities, or placed on a reduced schedule
they did not request. Parent may not know the term "partial day attendance."
Also matches when parent asks what PDA is, what informal vs formal PDA looks
like, or whether what is happening to their child counts as exclusion.
"""),
                response_pattern=_t("""
Response pattern:
1. Acknowledge the situation warmly.
2. Identify and name it: "This is often referred to as involuntary partial
   day attendance" — use plain, parent-friendly language.
3. Explain clearly: a student attending less than the full day, not because
   the family requested it, but because the school believes it cannot currently
   support full participation.
4. Normalize: "Many families experience this and are often unsure what to do next."
5. Orient: "There are steps you can take to understand why and what options
   may be available."
6. Offer next step: "Let's start by understanding why the school reduced
   your child's schedule."

Key distinctions to help the parent understand:
- Informal PDA: not documented, evolves gradually, school may use terms like
  "temporary," "gradual," "flexible" instead of "partial day attendance."
- Formal PDA: documented, deliberately implemented, tied to a plan or decision.
- Participation-based exclusion: child technically attends but misses field
  trips, assemblies, activities — attendance without meaningful participation.
- Do NOT classify as PDA: family-requested reduced schedules, illness-related
  absences, temporary suspensions, voluntary homeschooling.

When the parent asks about consequences of informal PDA: explain how reduced
participation can limit opportunities to observe support needs, affect academic
progress, social participation, belonging, and skill development.
"""),
            ),
            Cluster(
                key="B",
                name="Understanding the school's reason",
                sort_order=2,
                matches_when=_t("""
Parent wants to know why their child was sent home, excluded
from a field trip, or had their schedule reduced. May describe a specific
reason the school gave (behaviour, staffing, safety) or may be unclear.
"""),
                response_pattern=_t("""
Response pattern:
1. Clarify the reason the school provided.
2. Help categorize: behaviour, safety, staffing limitations, lack of
   supports, transportation, unmet accommodation needs.
3. Explain the category in plain language.
4. Help identify gaps: "Has the school explained what supports were tried
   before reducing attendance?"
5. Reframe toward problem-solving: "Understanding the exact reason is
   important because different situations may require different responses."
6. Offer next step: identify what information may still be needed.

For field trip exclusion specifically: connect to participation and inclusion,
explain that field trips are part of the educational experience, and suggest
asking what barriers were identified and what accommodations were considered.
"""),
            ),
            Cluster(
                key="C",
                name="Responding in the moment",
                sort_order=3,
                matches_when=_t("""
Parent just received a call to pick up their child, or the
school is asking them to come get their child right now.
"""),
                response_pattern=_t("""
Response pattern:
1. Acknowledge: "Let's gather information before deciding what to do next."
2. Clarify: "Did the school explain why?"
3. Gather facts: "Is there an immediate safety concern or emergency?"
4. Explore supports: "What interventions were attempted before calling you?"
5. Identify patterns: "Has this happened before, or is this the first time?"
6. Help organize: note who called, the reason, and actions taken.
7. Suggest next step based on the information gathered.
"""),
            ),
            Cluster(
                key="D",
                name="Documentation and evidence gathering",
                sort_order=4,
                matches_when=_t("""
Parent needs to request the school's decision in writing,
wants to know what documentation to request, needs guidance on what to
document during conversations, or wants to track their actions.
"""),
                response_pattern=_t("""
Response pattern:
1. Explain why documentation matters: "Having the decision in writing helps
   ensure everyone has a shared understanding."
2. Clarify what to request: reason for decision, when it was made, who was
   involved, supports attempted, expected duration, plan for returning to
   full-time attendance.
3. Provide practical guidance with sample wording:
   *"Could you please provide the decision and the reasons for it in writing
   so I can better understand the plan moving forward?"*
4. Encourage record-keeping: keep copies, note dates and who was involved.
5. For conversation documentation: note date/time, who attended, concerns
   discussed, decisions made, commitments/promises, timelines, next steps.
6. Suggest sending a follow-up summary email after meetings.
7. Offer next step: "Once you receive the documentation, we can review it
   and identify any gaps."
"""),
            ),
            Cluster(
                key="E",
                name="Preparing for and navigating school meetings",
                sort_order=5,
                matches_when=_t("""
Parent has an upcoming meeting, wants to know what to bring,
how to prepare, or how to participate effectively.
"""),
                response_pattern=_t("""
Response pattern:
1. Clarify the meeting purpose (attendance, supports, behaviour, transition,
   IEP review, course selection).
2. Suggest what to bring: recent communications, notes/concerns, questions,
   assessments/reports, support plans, notebook for notes.
3. Encourage goal-setting: what outcome do you hope for, what decisions need
   clarification, what concerns need addressing.
4. Suggest key questions based on the meeting type.
5. Discuss whether to bring a support person (normalize this).
6. Encourage documentation during the meeting.
7. Suggest follow-up: send a summary email confirming understanding.
"""),
            ),
            Cluster(
                key="F",
                name="Support plan implementation",
                sort_order=6,
                matches_when=_t("""
Parent believes a support plan, IEP, behaviour plan, or
accommodation plan exists but is not being followed consistently.
"""),
                response_pattern=_t("""
Response pattern:
1. Acknowledge: "You're wondering whether the supports already identified
   are being implemented as intended."
2. Clarify what plan exists (IEP, behaviour plan, accommodation plan).
3. Distinguish having a plan from implementing it: "It's important to
   understand how consistently the plan is being followed in practice."
4. Suggest areas to explore: which parts are being implemented, how often,
   what changes were made, what evidence of effectiveness exists.
5. Help identify gaps between the documented plan and current practice.
6. Connect to attendance: "Understanding support implementation can inform
   discussions about full-time participation."
7. Suggest next step: review the plan with the school and discuss implementation.
"""),
            ),
            Cluster(
                key="G",
                name="Non-response, denial, and school pushback",
                sort_order=7,
                matches_when=_t("""
Parent has not received a response, received a denial, got a
vague/partial/delayed response, or school is pushing back on their requests.
"""),
                response_pattern=_t("""
Response pattern for non-response:
1. Acknowledge frustration. Clarify how long it has been.
2. Normalize: "Schools may be delayed, but it is reasonable to follow up."
3. Provide follow-up language: *"I'm following up on my previous request
   regarding my child's attendance. I would appreciate an update."*
4. Encourage documenting follow-up attempts.
5. Explain future options if repeated attempts do not work.

Response pattern for denial:
1. Acknowledge the disappointment.
2. Clarify: "Did the school explain why they declined?"
3. Explore: is this temporary, conditional, or final?
4. Identify next steps: request clarification, ask what conditions would
   change the decision, review documentation, discuss alternatives.
5. Discuss escalation readiness if concerns remain unresolved.

Response pattern for vague/partial/delayed response:
1. Help categorize: partial compliance, vague response, delayed action,
   commitment without timeline, request for more information.
2. Explain what may still be missing.
3. Suggest follow-up questions: Has a decision been made? What is the
   current status? When can I expect an update?
4. Encourage documentation of commitments and timelines.

Core pattern for all pushback situations:
Understand the reason -> Clarify the decision -> Explore options -> Determine next steps.
"""),
            ),
            Cluster(
                key="H",
                name="Escalation and appeals",
                sort_order=8,
                matches_when=_t("""
Parent has tried multiple discussions without progress, wants
to know when to escalate, how to escalate, what an appeal is, or whether
to involve a lawyer.
"""),
                response_pattern=_t("""
Response pattern:
1. Assess readiness: review what actions have been taken and responses received.
2. Identify escalation indicators: repeated meetings without progress,
   unfulfilled commitments, lack of response, unresolved concerns.
3. Explain escalation options: higher-level review, advocacy support,
   additional school/district personnel, formal appeal process.
4. Explain appeals in plain language: "A formal process to request that a
   decision be reviewed by someone with authority to reconsider it."
5. Emphasize preparation: organized documentation and timeline of events.
6. For legal support questions: explain it is one option among many, identify
   situations where families commonly seek legal advice, distinguish from
   advocacy and mediation. NEVER recommend retaining a lawyer.
7. Frame constructively: "The goal is to bring additional attention and
   decision-making to the issue, not to create conflict."
"""),
            ),
            Cluster(
                key="I",
                name="Rights, concepts, and advocacy frameworks",
                sort_order=9,
                matches_when=_t("""
Parent asks about their child's rights, inclusive education,
duty to accommodate, undue hardship, Article 24, personal care, medication
support, course selection rights, or inclusion beyond academics.
"""),
                response_pattern=_t("""
Response pattern:
1. Explain the concept in plain language.
2. Connect to the parent's specific situation.
3. Provide practical questions the parent can use in discussions.
4. Reference relevant frameworks (CRPD Article 24, human rights principles)
   without providing legal interpretation.
5. Encourage collaborative problem-solving.

Key concept guidance:

Rights: Educational rights support access, participation, accommodations,
and protection from discrimination. Help families understand and use them
confidently — "Knowing your child's rights simply helps you participate
more confidently in discussions and decisions."

Duty to accommodate: The responsibility to identify and implement reasonable
supports that help students participate. Focus on what efforts should be
considered, not whether a duty has been met.

Undue hardship: A high threshold — typically more than inconvenience,
preference, or administrative difficulty. Encourage asking what options were
considered. NEVER determine whether undue hardship has been reached.

Article 24: Translate into practical questions: "How does this decision
support my child's participation?" "What supports could make participation
possible?" Focus on participation and inclusion, not quoting legal text.

Personal care: Essential for attendance, participation, and dignity. Explain
common supports (toileting, feeding, mobility, hygiene). Emphasize dignity
and privacy alongside safety.

Medication: Practices vary by jurisdiction. Explain common supports and
planning processes. Encourage proactive planning. NEVER provide medical advice.

Course selection rights: Students and families should have meaningful
involvement in educational planning. Connect to future opportunities.

Inclusion beyond academics: Participation in field trips, clubs, sports,
events. "The focus is not simply whether a student is present at school,
but whether they are included in the opportunities that make up school life."
"""),
            ),
            Cluster(
                key="J",
                name="Finding support and getting involved",
                sort_order=10,
                matches_when=_t("""
Parent asks who can help them, wants support navigating the
situation, or wants to get involved in changing PDA in Canada.
"""),
                response_pattern=_t("""
Response pattern:
1. Normalize: "You do not have to navigate this situation alone."
2. Identify support types: school staff, district personnel, parent advocacy
   organizations, disability organizations, community support groups,
   other families with similar experiences, advocates, professionals.
3. Explain different roles: information, advocacy guidance, emotional/peer support.
4. For meeting support: spouse, family member, friend, advocate, community
   support person, note-taker. Frame as collaborative, not adversarial.
5. For getting involved: consultations, sharing experiences, advisory groups,
   supporting other families, research/surveys, raising awareness.
6. Help narrow options: "What type of support feels most helpful right now?"
"""),
            ),
        ),
    ),
    Journey(
        key="J2",
        name="Transitions and future planning",
        sort_order=2,
        description=_t("""
A family is planning for the future: transitions between schools, course
selection, graduation pathways, work experience, support quality,
extracurricular inclusion, and teacher accountability.
"""),
        detection_signals=_t("""
"transition," "moving to high school," "course selection," "graduation,"
"credits," "prerequisites," "work experience," "support quality,"
"EA," "extracurricular," "future planning," "what to expect,"
"independence," "scaffolding," "learning goals," "full day"
"""),
        detective_questions=_t("""
1. What school stage — elementary, middle school, entering high school,
   in high school, post-secondary planning?
2. What is the concern — course selection, graduation credits, transition
   planning, EA/support effectiveness, independence and belonging,
   learning quality, extracurricular inclusion, teacher expectations?
3. What have they done so far — meetings, discussions with school, nothing yet?
"""),
        guidance=_t("""
For this journey, support future planning without limiting possibilities,
transition planning and navigation, and advocating for effective supports
that enable inclusion.
"""),
        clusters=(
            Cluster(
                key="K",
                name="Course selection and keeping options open",
                sort_order=1,
                matches_when=_t("""
Parent asks about course selection, keeping future options
available, graduation credits, prerequisites, or educational pathways.
"""),
                response_pattern=_t("""
Response pattern:
1. Explain how course selections influence future opportunities.
2. Reframe: "Which options keep the greatest number of future pathways
   available?" rather than "Which courses are easiest?"
3. Explore the student's interests, strengths, and goals.
4. Explain that support needs do not determine which courses a student can
   pursue — accommodations can enable participation in a wide range of courses.
5. Connect to graduation: explain how credits work, the difference between
   credit-bearing and non-credit courses.
6. For prerequisites: explain what they are, how current decisions affect
   future eligibility, encourage understanding before deciding.
7. For progress monitoring: help identify signs of academic difficulty early,
   encourage regular review, suggest questions about progress and supports.
8. Encourage keeping options open while interests develop.

Key principle: "Do not make today's decisions based solely on today's challenges."
"""),
            ),
            Cluster(
                key="L",
                name="Transition planning and navigation",
                sort_order=2,
                matches_when=_t("""
Parent asks about an upcoming transition, what to expect,
when planning should start, what questions to ask, or what challenges
to anticipate.
"""),
                response_pattern=_t("""
Response pattern:
1. Explain transition planning purpose and why early planning matters.
2. Provide stage-based guidance:

   Elementary to Middle School:
   - Maintaining inclusion and belonging
   - Preserving friendships
   - Support continuity
   - Maintaining learning expectations

   Middle School to High School:
   - Course selection and pathway planning
   - Graduation planning
   - Future opportunities
   - Avoiding premature narrowing of options

   High School to Post-Secondary/Community:
   - Employment preparation
   - Post-secondary options
   - Adult services and community participation
   - Transition-to-adulthood planning

3. Identify who should be involved: family, current educators, future
   educators, support staff, the student when appropriate.
4. Suggest stage-appropriate questions covering: learning goals, supports,
   inclusion and participation, future planning.
5. Highlight commonly overlooked topics: future opportunities, social
   inclusion, course planning (families often focus only on supports).
6. Identify common challenges and roadblocks:
   - Planning starts too late
   - Information not shared between schools
   - Expectations lowered without discussion
   - Important stakeholders missing
   - Pathway decisions made before alternatives explored
7. Encourage proactive participation before decisions are finalized.

Through line: "Help me see around corners so I can prepare before
opportunities are lost."
"""),
            ),
            Cluster(
                key="M",
                name="Meaningful learning and quality education",
                sort_order=3,
                matches_when=_t("""
Parent asks about learning quality, whether their child is
actually learning, teacher expectations, alternative pathways when
graduation is difficult, or quality education beyond credits.
"""),
                response_pattern=_t("""
Response pattern:
1. Explain the principle: "Quality education includes both participation
   AND meaningful learning, growth, and achievement."
2. Help distinguish participation from educational progress.
3. Suggest questions about learning goals, progress measurement, growth
   evidence, and how goals connect to future opportunities.
4. For alternative pathways: explain that graduation is one of several
   educational outcomes. Present alternatives positively — vocational
   training, employment preparation, community-based learning,
   continuing education. Frame as: "What future is my child working
   toward?" not "Can my child graduate?"
5. For non-credit pathways: reinforce that meaningful learning includes
   new skills, independence, relationships, interests, employment
   preparation, community participation.
6. For teacher expectations: encourage sharing the child's strengths,
   interests, goals, and aspirations. Explain how expectations influence
   opportunities and outcomes.
7. Encourage regular review of learning goals.

Key reframe: "Credits = success" to "Meaningful learning = success"
(without minimizing the importance of graduation pathways).
"""),
            ),
            Cluster(
                key="N",
                name="Support quality and EA advocacy",
                sort_order=4,
                matches_when=_t("""
Parent asks about available supports, whether supports are
effective, EA support, independence vs dependence, scaffolding, full-day
participation with support, or monitoring support quality.
"""),
                response_pattern=_t("""
Response pattern:
1. Explain support types: accommodations, EA, communication supports,
   personal care, transportation, behavioural supports, assistive technology,
   environmental adaptations.
2. Reframe from quantity to quality: "The most important question is not
   'What support is my child entitled to?' but 'What support does my child
   need to participate and succeed?'"
3. Explain effective support indicators: meaningful participation, peer
   engagement, educational progress, growing confidence and independence,
   access to same opportunities as classmates.
4. Explain warning signs: limited progress, restricted participation,
   unnecessary dependence, reduced opportunities, limited social connections,
   work rarely changes in complexity, support staff completing tasks for
   the student.
5. For independence and belonging: explain that support should help students
   participate with peers, build friendships, make choices, and require
   less adult prompting over time. Flag if most interactions are with adults
   rather than peers.
6. For scaffolding: explain as "providing the right amount of support so a
   student can engage in learning that might otherwise be difficult."
   Balance: too little leads to frustration, too much limits growth.
7. For full-day participation: reframe from "can my child stay all day" to
   "what supports are needed for full participation." Connect to learning,
   friendships, extracurriculars, consistency.
8. For monitoring: suggest outcome-focused check-ins rather than daily
   oversight. Key questions: Is my child learning? Are supports working?
   Is participation improving? Is independence increasing?
9. For building an advocacy team: normalize involving others in meetings.
   Identify who can help: family, advocates, professionals, the student.

Through line: "Good supports are defined not by what is provided, but by
the opportunities they create."
"""),
            ),
            Cluster(
                key="O",
                name="Extracurricular and community inclusion",
                sort_order=5,
                matches_when=_t("""
Parent asks about field trips, clubs, sports, school events,
after-school activities, or inclusion beyond academics.
"""),
                response_pattern=_t("""
Response pattern:
1. Expand the concept: "Inclusive education is about more than academics.
   Participation, belonging, and social connection are also important."
2. Provide examples: field trips, clubs, sports, assemblies, graduation
   activities, lunch/recreation, school events.
3. Explain why it matters: friendships, confidence, skill development,
   community belonging, memories that shape the school experience.
4. Suggest questions: What barriers prevent participation? What supports
   could help? What alternatives were considered?
5. Connect to future opportunities: employment, community participation,
   independence, personal growth.
"""),
            ),
        ),
    ),
))


# ------------------------------------------------------------------
# Situation steps formatting (mirrors cleanSteps in migration 028)
# ------------------------------------------------------------------

_ITEM = re.compile(r"^(\d+\.|[-*•])\s")


def clean_steps(text: str) -> str:
    """
    Formatting-only cleanup of seeded situation steps: drop a leading
    "Response pattern:" line and join hard-wrapped lines onto their item or
    paragraph. No words change; idempotent.
    """
    lines = (text or "").replace("\r\n", "\n").split("\n")
    if lines and lines[0].strip() == "Response pattern:":
        lines = lines[1:]
    out: List[str] = []
    for raw in lines:
        line = raw.rstrip()
        stripped = line.strip()
        if not stripped:
            out.append("")
            continue
        prev = out[-1] if out else ""
        indented = line[:1].isspace()
        continues = prev != "" and not _ITEM.match(stripped) and (indented or not prev.endswith(":"))
        if continues:
            out[-1] = f"{prev} {stripped}"
        else:
            out.append(stripped)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()


# Migration 028 published the cleaned steps for the seeded situations; the
# fallback catalog matches what the database holds after it.
DEFAULT_CATALOG = JourneyCatalog(tuple(
    replace(j, clusters=tuple(replace(c, response_pattern=clean_steps(c.response_pattern)) for c in j.clusters))
    for j in DEFAULT_CATALOG.journeys
))
