# ESL Assessment Monitoring

This context covers the monitoring records produced while a student completes a Test. It keeps each student's work and monitoring artifacts distinguishable across repeat attempts.

## Assessment Sessions

**Attempt**:
A single, continuous occasion on which one Student starts and completes or abandons one Test. An Attempt owns only the evidence created during that occasion.
_Avoid_: Test Result, test session

**Screen Evidence Capture**:
A screenshot of the entire display obtained from an active screen-share stream during an Attempt. It is identified by its capture time and trigger, and is stored within the Attempt that produced it.
_Avoid_: Webcam frame, violation photo

**Violation**:
A monitoring signal that an Attempt no longer meets a required condition, such as a stopped camera or screen share. A Violation may refer to the most recent valid Screen Evidence Capture; it must not be represented by a blank image.
_Avoid_: Black screenshot, proof of cheating

**Evidence Namespace**:
The Firebase Storage hierarchy that groups Screen Evidence Captures by Test, class name, Student, and Attempt, in that order. Readable names support direct teacher review, while the Test, Student, and Attempt identifiers prevent ambiguity.
_Avoid_: UID-first folders, flat evidence uploads
