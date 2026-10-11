# Audio acquisition and playback model — assessment

Status: internal factual assessment based on primary sources reviewed October 2026.
This document concerns **only** how the app obtains and plays YouTube-sourced audio.
It is deliberately separate from the software's Apache-2.0 licensing and NOTICE
attribution questions, which are covered in `README.md` and `NOTICE`.

It is not legal advice; it records what the sources say and where the open questions are.

## What the app actually does

Three distinct mechanisms, each with a different risk profile:

| # | Mechanism | Where it happens | Data at rest |
|---|-----------|------------------|--------------|
| 1 | **InnerTube resolution** — the server resolves audio stream URLs from YouTube Music using the public web client context, without an official YouTube Data API key | server (`server/src/services/proxy.ts`, `youtubeAccount.ts`) | no audio stored; short-lived stream URLs |
| 2 | **Stream relaying** — the Node server fetches the audio stream and re-serves it in real time to a signed-in user | server (media API) | no audio written to the server disk (streamed through) |
| 3 | **Browser-side offline copy** — optional feature stores the audio in the *listener's own* IndexedDB for offline playback | client only (`client/src/plugins/official/downloader/`) | audio in the listener's own browser storage |

The three are evaluated separately below, then the secondary-liability framing,
then the residual questions.

---

## 1. InnerTube access (URL resolution without an API key)

**YouTube Terms of Service** (https://www.youtube.com/t/terms, effective December 15, 2023),
"Your Use of the Service" → "Permissions and Restrictions":

> "access, reproduce, download, distribute, transmit, broadcast, display, sell, license,
> alter, modify or otherwise use any part of the Service or any Content except:
> (a) as expressly authorized by the Service; or (b) with prior written permission from
> YouTube and, if applicable, the respective rights holders;"

> "access the Service using any automated means (such as robots, botnets or scrapers)
> except (a) in the case of public search engines, in accordance with YouTube's
> robots.txt file; or (b) with YouTube's prior written permission;"

> "circumvent, disable, fraudulently engage with, or otherwise interfere with any part of
> the Service (or attempt to do any of these things), including security-related features
> or features that (a) prevent or restrict the copying or other use of Content or
> (b) limit the use of the Service or Content;"

The same section limits use to:

> "personal, non-commercial use (for example, you may not publicly screen videos or
> stream music from the Service);"

**YouTube API Services Developer Policies** (https://developers.google.com/youtube/terms/developer-policies),
§III.D "Accessing YouTube API Services":

> "You must not use undocumented APIs without express permission. You must access data
> from YouTube API services only according to the means stipulated in the authorized
> documentation of that YouTube API service."

§III.E "Handling YouTube Data and Content" → "Scraping":

> "You and your API Clients must not, and must not encourage, enable, or require others
> to, directly or indirectly, scrape YouTube Applications or Google Applications, or
> obtain scraped YouTube data or content."

**API Services Terms of Service** (https://developers.google.com/youtube/terms/api-services-terms-of-service)
§3.1 requires accessing the API services only "by the means described in the Agreement,"
and §15 prohibits exceeding or circumventing quota restrictions.

**Assessment.** The app does not use the official YouTube Data API; it uses the same
InnerTube endpoints the web client uses, with the public web client context. Google
publishes no statement naming InnerTube, but the Developer Policies' ban on
*undocumented APIs without express permission* and on *scraping YouTube Applications* are
the closest official language, and ToS §"Permissions and Restrictions" independently
prohibits automated access without prior written permission. This is best characterized
as a **contract/policy exposure for the operator** (ToS and developer-policy breach), not
a copyright claim against users. Enforcement to date in this ecosystem has been
operational (botguard/PoToken challenges, IP throttling, key rotation) rather than
litigation — note the project's own `client/src/datasource/youtube/poToken.ts`, which
implements the anti-bot challenge response the platform deploys against exactly this
access pattern. The Invidious project's account of Google legal contact
(https://github.com/iv-org/invidious/issues/3872) is developer-side reporting, not a
Google policy statement or adjudicated finding.

## 2. Stream relaying (server re-serves the audio in real time)

**Developer Policies** §III.E.1 "Audiovisual Content":

> "You and your API Clients must not, and must not encourage, enable, or require others to:
> download, import, backup, cache, or store copies of YouTube audiovisual content without
> YouTube's prior written approval,
> make content available for offline playback, or
> use any aspect of the YouTube API Services to facilitate or promote copyright
> infringement or the exploitation of copyright-infringing materials."

**API Services Terms** §16.3:

> "no rights or licenses are granted to reproduce or distribute audiovisual content or
> make audiovisual content available in any manner other than through the use of the
> YouTube API Services in accordance with the Agreement."

These provisions bind *API Clients* of the official API services; the app is not an API
Client (it uses no API key), which cuts both ways — it is outside the grant, and outside
the policy's literal "API Client" scope. The ToS's own restrictions in §1 above
(reproduce/transmit except as authorized; non-commercial personal use) are the operative
contract terms for a person using the Service.

**Copyright framing for the relay hop.** Two distinct questions:

- *Does the server make a "copy"?* The Ninth Circuit's "server test" — a work is copied
  when "embodied (i.e., stored) in a computer's server"
  (*Perfect 10 v. Amazon.com*, 508 F.3d 1146, 1159–60 (9th Cir. 2007)) — distinguishes
  storage from display. A relay that streams bytes through RAM without persisting them
  makes this factually contested; the app deliberately writes no audio to server disk
  (see `NOTICE`, "the server relays audio for playback without writing audio files to
  its own disk"). Whether transient buffering constitutes a reproduction is unresolved
  and fact-specific; *Perfect 10* itself concerned image linking and should not be cited
  as a categorical answer for audio relays.
- *Secondary liability.* *Viacom v. YouTube*, 676 F.3d 19, 30–35 (2d Cir. 2012) frames
  §512 knowledge around "specific and identifiable instances of infringement" — a
  service-provider safe-harbor standard, not a general immunity, and §512 safe harbors
  presuppose the threshold conditions (agent designation, repeat-infringer policy, no
  financial benefit + right and ability to control). A small private instance with
  signed-in accounts should not assume safe-harbor eligibility. *Sony*
  (464 U.S. 417, 442–56 (1984)) supports noncommercial time-shifting of free broadcast
  content; it does not establish a right to copy subscription-streaming audio or to
  relay it to other users, and does not displace the ToS contract question.

**Assessment.** Relaying is the mechanism with the largest gap between "no file is
written" and "a copy is nonetheless made," and the one most exposed to *contract* claims
(ToS restrictions on transmitting/using content outside the Service) plus potential
secondary-liability theories if the instance is later characterized as facilitating
widespread copying. Its private, authenticated, non-commercial posture is its strongest
mitigating fact pattern.

## 3. Browser-side offline copies (listener's own IndexedDB)

**Developer Policies** §III.E.1 (quoted above) prohibit *making content available for
offline playback* and storing copies without YouTube's prior written approval — but
again, by its terms this binds API Clients using the official API services.

**YouTube's sanctioned offline path** — YouTube Help, "Watch videos offline with YouTube
Premium" (https://support.google.com/youtube/answer/11977233):

> "If YouTube Premium is available in your location, you can download and watch videos
> on your mobile device. You can also download videos from your computer using Chrome,
> Edge, Firefox & Opera browsers."

> "Downloaded videos can be played offline for up to 29 days. After that, you'll need to
> reconnect your device to the internet."

> "You must be signed in to your Premium account to download videos. Videos added to
> your downloads can be played while signed in with the same account."

So YouTube itself now sanctions desktop-browser offline downloads — but *only* inside
its own interface, tied to a Premium account, expiring on a 29-day recheck. There is no
provision covering an export of the audio into another application's storage.

**Assessment.** Relative to the other two mechanisms, a copy held in the *listener's own
browser* is the closest analogue to personal format-shifting, which is the strongest
place to stand under *Sony*'s time-shifting rationale for private noncommercial use —
but it is still a copy obtained outside any authorization YouTube recognizes, and it is
exactly the "offline playback" behavior §III.E.1 names when Google chooses to apply its
developer policies. The mechanism that matters most here is not copyright but
**contract**: the ToS restrictions quoted in §1 apply to the listener's conduct too.

## 4. DMCA §1201 (circumvention) exposure

**17 U.S.C. §1201(a)(1)(A)** (https://www.copyright.gov/title17/92chap12.html):

> "No person shall circumvent a technological measure that effectively controls access
> to a work protected under this title."

Circumvention is defined (§1201(a)(3)(A)) as "to descramble a scrambled work, to decrypt
an encrypted work, or otherwise to avoid, bypass, remove, deactivate, or impair a
technological measure, without the authority of the copyright owner"; a measure
"effectively controls access" when it requires authorized information, a process, or a
treatment to gain access (§1201(a)(3)(B)).

Whether resolving a signed stream URL implicates §1201 turns on facts the reviewed
sources do not settle: whether the URL signature scheme is an *access control* to a
*protected work* at the moment of resolution, and whether the resolver acts "without the
authority of the copyright owner." Nothing in the primary sources reviewed establishes
that YouTube's stream-URL signature scheme has been adjudicated as an effective access
control, or that any particular resolver violates §1201.

Relevant rulemaking context: the Copyright Office's **2018 §1201 FAQ** records that the
Acting Register "did not recommend, and the Librarian declined to adopt, exemptions with
respect to … Audiovisual works, for broad-based space-shifting and format-shifting
(lack of legal and factual support for exemption)" (https://www.copyright.gov/1201/2018/faqs.html);
see also 80 FR 65944 (Oct. 28, 2015). No exemption on record specifically addresses
YouTube stream-URL signatures either way. (*MGE UPS Systems v. GE Consumer & Industrial*,
622 F.3d 361, 367–68 (5th Cir. 2010): §1201(a)(1) "is targeted at circumvention" and
"does not apply to the use of copyrighted works after the technological measure has been
circumvented" — separating circumvention conduct from later use. §1201(c)(2) keeps
§1201 distinct from vicarious/contributory infringement doctrine.)

**Assessment.** §1201 is the theory most likely to be *asserted* against stream-resolution
tooling generally, and the one where the app's posture is hardest to defend on the
current record — because it does not depend on the app being public or commercial, and
because triennial exemptions for personal space-shifting have been declined. It is also
the theory least developed in case law *as applied to signed stream URLs*, which cuts
both ways.

---

## Summary by mechanism

| Mechanism | Primary exposure | Secondary exposure | Strongest mitigation |
|-----------|-----------------|--------------------|----------------------|
| 1. InnerTube resolution | ToS contract + developer-policy breach (undocumented API, automated access) | §1201 if signature scheme deemed an access control | no API-key deception of the official API; operational rather than litigated enforcement history |
| 2. Stream relaying | ToS contract (reproduce/transmit outside the Service) | secondary copyright liability if instance shown to facilitate copying | private, authenticated, non-commercial; no audio persisted server-side |
| 3. Browser offline copy | ToS contract (listener's conduct) | developer-policy §III.E.1 if applied to this client | closest analogue to personal time-shifting (*Sony*); copy lives in the listener's own storage |

## Residual questions (not resolvable from public sources)

1. Whether Google applies Developer Policies §III.D/§III.E to non-API-key InnerTube
   clients at all — the policies' operative subject is "API Client(s)" and the app is
   not one; no Google statement naming InnerTube was located.
2. Whether YouTube's stream-URL signature scheme would be treated as an effective
   technological measure under §1201(a)(3)(B) — no adjudicated case located.
3. Whether a through-memory relay without disk persistence constitutes a
   "reproduction" — *Perfect 10*'s server test is suggestive, not controlling, for
   streamed audio.
4. Whether §512 safe harbor is available to a private multi-user instance at all —
   not analyzed here; requires the threshold conditions (designated agent, repeat
   -infringer policy, no disqualifying financial benefit/control).

## Sources

- YouTube Terms of Service — https://www.youtube.com/t/terms (eff. Dec 15, 2023)
- YouTube API Services Terms — https://developers.google.com/youtube/terms/api-services-terms-of-service (§§3.1, 15, 16.3)
- YouTube API Services Developer Policies — https://developers.google.com/youtube/terms/developer-policies (§§III.D, III.E, III.E.1, III.E.4)
- 17 U.S.C. §1201 — https://www.copyright.gov/title17/92chap12.html
- USCO 2018 §1201 FAQ — https://www.copyright.gov/1201/2018/faqs.html; 80 FR 65944 (2015)
- *Sony v. Universal*, 464 U.S. 417 (1984) — https://www.law.cornell.edu/supremecourt/text/464/417
- *Perfect 10 v. Amazon*, 508 F.3d 1146 (9th Cir. 2007)
- *Viacom v. YouTube*, 676 F.3d 19 (2d Cir. 2012)
- *MGE UPS v. GE*, 622 F.3d 361 (5th Cir. 2010)
- YouTube Premium offline downloads — https://support.google.com/youtube/answer/11977233
- Invidious #3872 (developer-side reporting, not a Google statement) — https://github.com/iv-org/invidious/issues/3872
