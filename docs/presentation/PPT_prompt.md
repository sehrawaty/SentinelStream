# Prompt for generating the SentinelStream deck

## How to use this

1. Start a new chat with Claude where it can create files (file creation / code execution turned on).
2. Attach these 20 files from `docs/presentation/`:
   - `SentinelStream_PPT_content.md`
   - the 6 diagrams: `fig-01-architecture.png` … `fig-06-ring-handoff.png`
   - the 13 screenshots: `shot-01-live-monitor.png` … `shot-13-index-registry.png`
3. Paste everything below the line as your message.

If your chat allows fewer than 20 attachments, leave out `shot-05`, `shot-12`
and `shot-08` first; the prompt tells Claude what to do when an image is missing.

---

Build a PowerPoint deck (.pptx, 16:9) for a university course-project review. I have attached one Markdown file and 19 PNG images.

## What this is for

I am presenting my NoSQL Databases course project, SentinelStream, to my teacher. I am marked on five criteria, and the deck has to make each one easy to find and easy to mark:

1. System Design
2. Database Implementation
3. Query Quality
4. Prototype / Demo
5. Documentation & Progress

The audience is a database teacher: they know MongoDB, Redis and Neo4j well and have not seen this system. They will look for whether I understand why each design choice was made, and whether the evidence is real. A deck that looks generated, padded or decorative will count against me, so I want it to look like a careful engineer made it by hand.

## Your source material

`SentinelStream_PPT_content.md` is the only source of facts. It has the theory for each criterion (Parts 0 to 6), a manifest of the images with what each shows and where to crop it (Part 7), and a slide-by-slide storyboard with titles, content, visuals and speaker notes (Part 8).

- Follow the storyboard in Part 8: same slides, same order. You may tighten wording and adjust layout. If a slide's content does not fit cleanly, split it into two slides. Do not drop content to make it fit, and do not merge slides.
- Every number, name, command and claim on a slide must come from that file. Do not add facts, statistics, features, citations or team members. If something you want to say is not in the file, leave it out.
- Before building, read the whole file, and look at every attached image so you know what it actually contains.

## The images

- Use the attached PNGs by their exact filenames, where the storyboard says. They are real diagrams and real screenshots of the running system.
- Do not redraw, recolour, stretch, tilt, round, or add shadows, glows or device frames to any of them. Keep the aspect ratio. A thin 0.75 pt border in a light grey is the only treatment a screenshot gets.
- The six `fig-` diagrams are finished artwork on a white background. Place each one large, on a white area, and let it carry the slide: do not rebuild it from shapes and do not crowd it with extra text.
- Where the manifest gives a crop box, use it when the slide needs the detail to be readable (the crop boxes are fractions of the image: left, top, right, bottom). Where a slide shows the full screenshot, show it full.
- Screenshots contain small text. Give them enough room that the part being discussed can be read from the back of a classroom. If it cannot, crop tighter or give the image its own slide.
- Under every image put a one-line caption in small grey text saying what it shows, taken from the manifest.
- If an image named in the storyboard was not attached, leave a plain bordered placeholder of the right size with the filename written in it, and list the missing files in your final message. Do not substitute another image or generate one.

## Design

Make it plain, consistent and precise. Restraint is the goal.

**Canvas and grid.** 16:9 (13.333 in × 7.5 in). Margins of 0.5 in on all sides. Use one layout grid for the whole deck, so titles, body and images start at the same positions on every slide.

**Type.** One sans-serif family for everything (Segoe UI; fall back to Calibri). Consolas for code, commands, field names and key names. Title 28 pt semibold. Body 16 to 18 pt. Table text no smaller than 12 pt. Captions and footers 10 to 11 pt. Left-align all text; never centre body text.

**Colour.** White or near-white slide background (#FFFFFF or #FAFAF8). Text in near-black (#16181D) and one grey for secondary text (#5A5F69). One accent colour, #2563C9, used sparingly: the criterion tag, a key figure, a callout marker. The three stores have fixed colours that match the diagrams, and are used only when a slide element refers to that store: Redis #D14A3A, MongoDB #1F8F4E, Neo4j #2563C9. Use no other colours. No gradients anywhere.

**Every content slide has the same four parts.**
1. A small criterion tag at the top left in the accent colour, in capitals: SYSTEM DESIGN, DATABASE IMPLEMENTATION, QUERY QUALITY, PROTOTYPE / DEMO, or DOCUMENTATION & PROGRESS. This is how the marker maps slides to criteria, so it must be on every content slide and must match the storyboard.
2. A title that states the slide's point as a full sentence, as written in the storyboard. Two lines at most.
3. The content: one main thing per slide (a diagram, a screenshot, a table, or a code block), with at most a few supporting lines.
4. A footer with "SentinelStream" on the left and the slide number on the right.

**Text.** Keep slides light: about 40 words of body text at most, not counting tables and code. No more than four bullets on a slide, and prefer a table, a labelled figure or two short sentences over bullets. Write in plain sentences. Put the detail in the speaker notes, not on the slide.

**Tables.** Hairline horizontal rules only, no vertical lines, no filled cells except a very light grey header row. Left-align text, right-align numbers. Use real table objects, not text boxes lined up by hand.

**Code and commands.** Consolas, 12 to 14 pt, on a very light grey panel (#F3F3F0), no syntax colouring, no more than about 12 lines per block. Copy code exactly from the content file.

**Key figures.** Where the storyboard calls for large figures (slide 21), show at most four, each as a large number with a short label beneath it. No icons.

**Callouts.** Where the storyboard says to point at something in a screenshot, mark it with a thin accent-coloured rectangle outline or a small numbered circle, and explain it in the caption or a short label. No arrows with heads larger than the text, no speech bubbles.

**Do not use any of the following.** Stock photos or generated images. Icons or emoji. Clip art. Decorative shapes, blobs, swooshes or background patterns. Gradients, drop shadows, glows or 3D effects. Rounded "card" boxes with an icon and three words. Slides that are only a heading and a tagline. Centred titles on content slides. Animations or transitions. A "Thank you" slide. Text that runs off the slide or shrinks to fit.

## Speaker notes

Put the storyboard's "Notes" text in the speaker notes of each slide, in the first person, as something I can say aloud in 30 to 45 seconds. For slide 20, the notes carry the ten demonstration steps from Part 4.2.

## How to work

1. Read the content file and view the images.
2. Build the deck with code (python-pptx or a comparable library) so positions and sizes are exact and consistent. Define the grid, type sizes and colours once and reuse them.
3. Render every slide to an image and look at each one. Fix anything that overflows, overlaps, is cut off, is too small to read, or sits off the grid. Check that every screenshot is sharp and correctly proportioned, and that every content slide has its criterion tag, title, footer and slide number. Repeat until every slide is clean.
4. Check the deck against the five criteria: each must have its section, in order, and the overview on slide 2 must list the right slide numbers for the deck as you finally built it.
5. Give me the .pptx file.

In your final message, tell me briefly: how many slides there are, which slides cover each of the five criteria, any image that was missing, any storyboard content you had to split across slides, and anything in the content file that looked inconsistent or unclear. Do not describe the design back to me.
