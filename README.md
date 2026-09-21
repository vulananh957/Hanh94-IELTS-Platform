# Hanh94 IELTS Platform

An evolving IELTS learning and assessment workspace for teachers and learners.

![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Firebase](https://img.shields.io/badge/Firebase-FFCA28?logo=firebase&logoColor=black)
![Vitest](https://img.shields.io/badge/Tests-Vitest-6E9F18?logo=vitest&logoColor=white)

## What I am building

Hanh94 started as a practical question: what would an IELTS platform look like if the test experience, teacher workflow, feedback loop and learning analytics were designed as one product instead of separate tools?

The repository is my attempt to answer that question. It brings together test creation, assignments, test-taking, grading, result review and progress tracking in a role-based system. The product is still evolving, but the core workflows are real enough to expose the difficult parts: representing IELTS content, keeping assessment state reliable, making feedback useful and giving teachers control without making the experience heavy.

## Product surface

### For learners

- Assigned tests and a focused test-taking flow
- Reading, listening and writing result views
- Performance history and progress signals
- Clear separation between objective scores and teacher-reviewed work
- Responsive interfaces for learning across devices

### For teachers

- Test creation, upload and editing workflows
- Student and assignment management
- Objective scoring plus manual grading tools
- Detailed result review and dashboard summaries
- Firebase-backed authentication, storage and data operations

## Where AI fits

I do not want AI to be a decorative chatbot attached to the product. In an assessment system, it has to earn trust.

The direction for Hanh94 is an AI-assisted grading workflow built around IELTS rubrics: accept a well-defined submission, return structured feedback, explain the evidence behind suggestions and keep the teacher in control of the final result. That means thinking about prompt and output contracts, consistency, uncertainty, human review and how feedback becomes useful product data—not only whether a model can produce a plausible paragraph.

Some of that pipeline is still a work in progress. The repository already contains the surrounding product architecture—submission flows, grading views, score calculation, result records and analytics surfaces—so AI can be integrated as a reliable system capability rather than a one-off demo.

## Engineering shape

- **Frontend:** Next.js, React, TypeScript and Tailwind CSS
- **Platform:** Firebase Authentication, Firestore, Storage, Hosting and Cloud Functions
- **State and workflows:** separate learner and teacher journeys with service and store layers
- **Assessment logic:** answer-key handling, score calculation, manual grading and result views
- **Quality:** Vitest, Testing Library, ESLint and environment-based configuration

The codebase is organized around product workflows rather than a collection of pages. UI components, services, stores, types and backend functions are kept separate so the assessment logic can grow without being buried inside the interface.

## Current status

This is an active build, not a finished commercial product.

The strongest parts today are the role-based dashboards, test lifecycle, teacher tooling, Firebase integration and the data flow from assignment to result. Areas still being developed include deeper AI evaluation, stronger automated coverage, production hardening and a more complete content-authoring experience.

I keep the unfinished edges visible because they show the actual engineering decisions behind the product and the direction I am taking next.

## Run locally

```bash
npm install
npm run dev
```

Create a local environment file from `.env.example` and add your Firebase configuration before starting the app.

Run the test suite with:

```bash
npm test
```

---

Built as a long-term product exploration in learning, assessment systems and trustworthy AI-assisted feedback.
