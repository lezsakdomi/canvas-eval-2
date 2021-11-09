import {parse} from "https://deno.land/std@0.111.0/flags/mod.ts";
import {join} from "https://deno.land/std@0.111.0/path/mod.ts";
import {styles} from "https://deno.land/x/ansi_styles@1.0.0/mod.ts";
import * as ansi from "https://deno.land/x/ansi@v0.1.1/mod.ts";

interface Args {
    verbose: boolean;
    cmd: string;
    directory?: string;
    canvas?: string;
    token?: string;
    course?: string | number;
    assignment?: string | number;
    user?: string;
    'except-user': string;
    test?: boolean;
    input?: string;
    output?: string;
    'dry-run': boolean;
}

// noinspection JSUnusedLocalSymbols
const usages: ((argv0: string) => string)[] = (() => {
    const commonOpts = `[--verbose] [--dry-run] [--canvas URL] [--token TOKEN] --course ID [--user ID,ID,... | --test]`;
    const evalOpts = `[--cmd COMMAND] [--directory DIR] --assignment ID`;
    const uploadOpts = ``
    return <((argv0: string) => string)[]>[
        argv0 => `${argv0} ${commonOpts} ${evalOpts} --output FILE`, // eval only, save intermediate output
        argv0 => `${argv0} ${commonOpts} --input FILE ${uploadOpts} [--output FILE]`, // upload only based on intermediate output
        argv0 => `${argv0} ${commonOpts} ${evalOpts} ${uploadOpts}`, // bth eval and upload
    ];
})();

interface CriteriaOutputData {
    points: number;
    comments?: string;
}

interface AssessmentOutputData {
    user_id: string;
    assessment_type: 'grading';

    [index: string]: any | CriteriaOutputData;
}

interface SerializedIntermediateData {
    canvas: string;
    course: number;
    assignment: number;
    rubricAssociationId?: number;
    assessmentOutputDataList: AssessmentOutputData[];
}

interface IntermediateData extends SerializedIntermediateData {
    rubricAssociationId: number;
}

interface InputData {
    rubricAssociationId: number | undefined;
    data: {
        assignment: {
            _id: string;
            name: string;
            course: {
                _id: string;
            };
            rubric: {
                _id: string,
                title: string;
                criteria: {
                    _id: string;
                    description: string;
                    longDescription: string;
                    ratings: {
                        _id: string;
                        description: string;
                        longDescription: string;
                        points: number;
                    }[];
                    points: number;
                }[];
                pointsPossible: number;
            };
            submissionsConnection: {
                nodes: {
                    _id: string;
                    user: {
                        _id: string;
                        name: string;
                    };
                    excused: boolean;
                    missing: boolean;
                    attachments: {
                        _id: string;
                        displayName: string;
                        url: string;
                    }[];
                    rubricAssessmentsConnection: {
                        nodes: {
                            _id: string;
                            rubricAssociation: {
                                _id: string;
                            };
                        }[];
                    };
                }[];
            };
        };
    };
}

const args: Args = <unknown>parse(Deno.env.get('CANVAS_EVAL_ARGS')?.split(/ +/g) || Deno.args, {
    string: [
        'cmd',
        'directory',
        'canvas',
        'token',
        'user',
        'except-user',
        'input',
        'output',
    ],
    boolean: [
        'verbose',
        'test',
        'dry-run',
    ],
    alias: {
        'verbose': 'v',
        'cmd': 'c',
        'directory': ['d', 'dir'],
        'token': 't',
        'assignment': 'a',
        'user': 'u',
        'except-user': 'U',
        'input': 'i',
        'output': 'o',
    },
    default: {
        cmd: "bash",
    },
}) as Args
for (const k in args) {
    // @ts-ignore
    if (Array.isArray(args[k])) args[k] = args[k][args[k].length - 1];
}

const verbose: boolean = args.verbose;

if (verbose) {
    console.log("CLI arguments (parsed):");
    console.dir(args);
}

const dryRun: boolean = args["dry-run"];

const canvas: string = args.canvas || Deno.env.get('CANVAS_URL') || "https://canvas.elte.hu"

const token: string = args.token || Deno.env.get('CANVAS_TOKEN') || (() => {
    throw new Error("Neither --token argument nor CANVAS_TOKEN env var provided")
})();

const assignment: number = ((assignment: number | string) => {
    if (isNaN(<number>assignment)) throw new Error("Assignment must be numeric (assignment ID), but it isn't");
    if (typeof assignment === "number") return assignment;
    return parseInt(assignment);
})(
    args.assignment || Deno.env.get('CANVAS_ASSIGNMENT') || (() => {
        throw new Error("Unable to figure out assignment ID: Specify either --assignment argument or CANVAS_ASSIGNMENT env var");
    })());

if (args.test) {
    const testUser: undefined | string = Deno.env.get('CANVAS_TEST_USER');
    if (!testUser) throw new Error("Could not figure out test user ID, please specify via CANVAS_TEST_USER env var");
    if (isNaN(<unknown>testUser as number)) throw new Error("Test user ID is non-numeric");
    args.user = testUser
}

const users: number[] | undefined = args.user?.split(/,\s*/g).map(user => {
    if (isNaN(<unknown>user as number)) throw new Error("User filter contains a non-numeric user");
    return parseInt(user);
});

const exceptUsers: number[] = args['except-user']?.split(/,\s*/g).map(user => {
    if (isNaN(<unknown>user as number)) throw new Error("Negative user filter contains a non-numeric user");
    return parseInt(user);
}) || [];

if (args.input) {
    const text = await Deno.readTextFile(args.input);
    const intermediateData = JSON.parse(text) as SerializedIntermediateData;

    if (!intermediateData.rubricAssociationId) {
        const {rubricAssociationId} = await graphql();
        intermediateData.rubricAssociationId = rubricAssociationId;
    }

    if (intermediateData.rubricAssociationId) {
        const uploadResult = await upload({
            ...intermediateData,
            rubricAssociationId: intermediateData.rubricAssociationId,
        });

        if (verbose || args.output) {
            const file = args.output || 'assessment-result.json';
            if (dryRun) console.log(`Would save upload result to ${file}`);
            else {
                await Deno.writeTextFile(file, JSON.stringify(uploadResult));
            }
        }
    } else {
        Deno.exit(1);
    }
} else {
    const inputData = await graphql();
    const intermediateData = await evaluate(inputData);

    if (verbose || args.output) {
        const file = args.output || "assessment-plan.json";
        if (dryRun) {
            console.log(`Would write assessment plan to ${file}`);
        } else {
            await Deno.writeTextFile(file, JSON.stringify(intermediateData));
        }
    }

    if (!args.output && inputData.rubricAssociationId) await upload({
        ...intermediateData,
        rubricAssociationId: inputData.rubricAssociationId,
    });
}

async function graphql(): Promise<InputData> {
    const {data} = await fetch(`${canvas}/api/graphql`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
            // language=GraphQL
            query: `query DataQuery($assignment: ID!) {
                assignment(id: $assignment) {
                    _id
                    name
                    course {
                        _id
                    }
                    rubric {
                        _id
                        title
                        criteria {
                            _id
                            description
                            longDescription
                            ratings {
                                _id
                                description
                                longDescription
                                points
                            }
                            points
                        }
                        pointsPossible
                    }
                    submissionsConnection {
                        nodes {
                            _id
                            user {
                                _id
                                name
                            }
                            excused
                            missing
                            attachments {
                                _id
                                displayName
                                url
                            }
                            rubricAssessmentsConnection {
                                nodes {
                                    _id
                                    rubricAssociation {
                                        _id
                                    }
                                }
                            }
                        }
                    }
                }
            }
            `,
            variables: {assignment: assignment.toString()},
        }),
    }).then((r) => r.json());
    if (verbose) {
        const file = 'graphql-response.json';
        if (dryRun) {
            console.log(`Would write graphql response to ${file}`);
        } else {
            await Deno.writeTextFile('graphql-response.json', JSON.stringify(data));
        }
    }

    const assignmentData = data.assignment;

    const courseData = assignmentData.course;

    const course: string = courseData._id;

    const rubricAssociationIds: number[] = assignmentData.submissionsConnection.nodes
        .map((submissionData: { rubricAssessmentsConnection: { nodes: { rubricAssociation: { _id: string } }[] } }) =>
            submissionData.rubricAssessmentsConnection.nodes
                .map(rubricAssessmentData => rubricAssessmentData.rubricAssociation._id)
                .map(id => parseInt(id))
        )
        .flat()
    const rubricAssociationId: number | undefined = (() => {
        if (rubricAssociationIds.length === 0) {
            console.log("Couldn't figure out rubric association ID: No assessment for the assignment yet.");
            console.log("Grade the Test User with a dummy grade to generate one.");
            console.log(`${canvas}/courses/${course}/gradebook/speed_grader?assignment_id=${assignment}`);
        } else if (!rubricAssociationIds.slice(1).every(id => id === rubricAssociationIds[0])) {
            console.log("Couldn't figure out rubric association ID: Multiple rubric association IDs found.");
            console.log("Found the following ones: %s", rubricAssociationIds.sort().filter((e, i, a) => !i || a[i - 1] != e).join(", "));
        } else {
            return rubricAssociationIds[0];
        }
        console.log("Warning: Uploading evaluation results is impossible without a rubric association ID.");
        return undefined;
    })();

    return {rubricAssociationId, data};
}

async function evaluate({data, rubricAssociationId}: InputData): Promise<SerializedIntermediateData> {
    const assignmentData = data.assignment;
    const rubricData = assignmentData.rubric;
    const courseData = assignmentData.course;

    const course: number = parseInt(courseData._id);

    const intermediateData: SerializedIntermediateData = {
        canvas, course, assignment,
        assessmentOutputDataList: [],
        rubricAssociationId: rubricAssociationId,
    };

    for (let submissionDataI = 0; submissionDataI < assignmentData.submissionsConnection.nodes.length; submissionDataI++) {
        const submissionData = assignmentData.submissionsConnection.nodes[submissionDataI];
        const userData = submissionData.user;
        const submissionUrl = `${canvas}/courses/${course}/assignments/${assignmentData._id}/submissions/`;
        if (users?.every(user => user.toString() !== userData._id) || exceptUsers?.some(user => user.toString() === userData._id)) {
            if (verbose) {
                console.log(`${styles.reset.open}[${(submissionDataI + 1).toString().padStart(2, '0')}/${assignmentData.submissionsConnection.nodes.length}] ${styles.strikethrough.open}Skipping submission ${ansi.link(submissionData._id, submissionUrl)} by ${styles.bold.open}${submissionData.user.name}${styles.bold.close}${styles.strikethrough.close}`);
            }
            continue;
        }
        console.log(`${styles.reset.open}[${(submissionDataI + 1).toString().padStart(2, '0')}` +
            `/${assignmentData.submissionsConnection.nodes.length}] ` +
            `${styles.underline.open}Evaluating submission ${ansi.link(submissionData._id, submissionUrl)} ` +
            `by ${styles.bold.open}${userData.name}${styles.bold.close}${styles.underline.close}`);

        const assessmentOutputData: AssessmentOutputData = {
            user_id: userData._id,
            assessment_type: 'grading',
        };

        const workDir = await Deno.makeTempDir({dir: args.directory})
        try {
            const submissionRestData = await fetch(
                `${canvas}/api/v1/courses/${course}/assignments/${assignmentData._id}/submissions/${userData._id}`, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                    },
                }
            ).then(r => r.json()) as {
                attachments: {
                    display_name: string;
                    url: string;
                }[];
            }

            for (const {display_name: displayName, url} of submissionRestData.attachments) {
                if (displayName.match('/|\/')) throw new Error(`BSOD: displayName contains a / (${displayName})`);
                const response = await fetch(url, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                    },
                });
                if (response.status != 200) throw new Error(`Unexpected status: ${response.status} ${response.statusText}`);
                if (!response.body) throw new Error("Got no body");
                const file = await Deno.open(join(workDir, displayName), {createNew: true, write: true});
                for await (const chunk of response.body) {
                    await (file as Deno.Writer).write(chunk);
                    if (args.verbose) {
                        await Deno.stdout.write(chunk);
                    }
                }
                file.close();
            }

            for (let criteriaDataI = 0; criteriaDataI < rubricData.criteria.length; criteriaDataI++) {
                const criteriaData = rubricData.criteria[criteriaDataI];
                console.log(`${styles.reset.open}[${(submissionDataI + 1).toString().padStart(2, '0')}` +
                    `/${assignmentData.submissionsConnection.nodes.length.toString().padStart(2, '0')} ` +
                    `#${(criteriaDataI + 1).toString()}] ` +
                    `${styles.italic.open}Testing for ` +
                    `${styles.bold.open}${criteriaData.description}${styles.bold.close}${styles.italic.close}`);

                const runOpts: Deno.RunOptions = {
                    cmd: args.cmd.split(/\s+/g), cwd: workDir,
                    stdin: "piped", stdout: "piped", stderr: "piped",
                    env: {
                        ASSIGNMENT_ID: assignmentData._id,
                        ASSIGNMENT_NAME: assignmentData.name,
                        USER_ID: userData._id,
                        USER_NAME: userData.name,
                        RUBRIC_ID: rubricData._id,
                        RUBRIC_TITLE: rubricData.title,
                        RUBRIC_POINTS: rubricData.pointsPossible.toString(),
                        CRITERIA_ID: criteriaData._id,
                        CRITERIA_DESCRIPTION: criteriaData.description,
                        CRITERIA_POINTS: criteriaData.points.toString(),
                    },
                }
                if (verbose) {
                    console.log("Executing", runOpts)
                }
                const process = Deno.run(runOpts)

                let output = ""

                const writePad = "[00/00 #0] ".replace(/./g, " ");
                let writePromise: Promise<{
                    clean: boolean,
                    bytesWritten: number,
                }> = Deno.stdout.write(new TextEncoder().encode(writePad))
                    .then(() => ({clean: true, bytesWritten: 0}));

                function write(buf: Uint8Array) {
                    const s = new TextDecoder().decode(buf)
                        .replace(/\n/g, "\n" + writePad)
                    writePromise = writePromise.then(async ({clean, bytesWritten}) => {
                        await Deno.stdout.write(new TextEncoder().encode(s));
                        return {
                            clean: buf.length ? buf[buf.length - 1] === 10 : clean,
                            bytesWritten: bytesWritten + buf.length,
                        };
                    })
                }

                const stdoutPromise = (async () => {
                    const buf = new Uint8Array(1024);
                    while (true) {
                        const bytesRead: number | null = await (process.stdout as Deno.Reader).read(buf)
                        if (bytesRead === null) break

                        write(buf.slice(0, bytesRead))
                        output += new TextDecoder().decode(buf.slice(0, bytesRead))

                        if (verbose) {
                            await Deno.stdout.write(new TextEncoder().encode(`[processed ${bytesRead} bytes from stdout]`));
                        }
                    }
                })();

                const stderrPromise = (async () => {
                    const buf = new Uint8Array(1024);
                    while (true) {
                        const bytesRead: number | null = await (process.stderr as Deno.Reader).read(buf)
                        if (bytesRead === null) break

                        write(buf.slice(0, bytesRead))

                        if (verbose) {
                            await Deno.stdout.write(new TextEncoder().encode(`[processed ${bytesRead} bytes from stdout]`));
                        }
                    }
                })();

                const stdinPromise = (async () => {
                    const text = criteriaData.longDescription
                        .replace(/<br\/>\r\n/g, "\n");
                    const input = new TextEncoder().encode(text);
                    await (process.stdin as Deno.Writer).write(input);
                    await (process.stdin as Deno.Closer).close();
                })().catch(e => {
                    writePromise = writePromise.then(async ({clean, bytesWritten}) => {
                        await Deno.stdout.write(new Uint8Array(clean ? [13] : [10]));
                        console.log("Failed writing process input");
                        console.dir(e)
                        await Deno.stdout.write(new TextEncoder().encode(writePad))
                        return {clean: true, bytesWritten}
                    })
                });

                await Promise.all([stdinPromise, stdoutPromise, stderrPromise]);

                const {bytesWritten, clean} = await writePromise;
                await Deno.stdout.write(new Uint8Array(clean ? [13] : [10]));
                if (verbose) {
                    console.log(`pipes closed, written ${bytesWritten} bytes`);
                }
                const status = await process.status();

                if (verbose) {
                    console.log({output, status});
                }

                assessmentOutputData[`criterion_${criteriaData._id}`] = {
                    points: status.success ? criteriaData.points : 0,
                    comments: output
                        .replace(/^ +/mg, s => '\u2008'.repeat(s.length))
                        // .replace(/ /g, '\u00a0')
                }
            }
        } finally {
            if (verbose) console.log("Cleaning up...");
            await Deno.remove(workDir, {recursive: true})
        }

        intermediateData.assessmentOutputDataList.push(assessmentOutputData);

        if (verbose) {
            console.log(assessmentOutputData);
        }
        // curl -L -H "Authorization: Bearer $CANVAS_TOKEN" \
        //   https://canvas.elte.hu/api/v1/courses/20697/rubric_associations/13700/rubric_assessments -X POST \
        //   -H 'Content-Type: application/x-www-form-urlencoded; charset=UTF-8' \
        //   --data "rubric_assessment[user_id]=286968&rubric_assessment[assessment_type]=grading"\
        //   "&rubric_assessment[criterion__1039][points]=0.5&rubric_assessment[criterion__1039][comments]=x%0Ay"
    }

    if (verbose) {
        console.log();
        console.log("Done evaluating all submissions.");
        console.dir(intermediateData);
    }

    return intermediateData;
}

async function upload(data: IntermediateData) {
    data.assessmentOutputDataList = data.assessmentOutputDataList.filter(assessmentOutputData => {
        if (users?.every(user => user.toString() !== assessmentOutputData.user_id) || exceptUsers?.some(user => user.toString() === assessmentOutputData.user_id)) {
            console.log(`Filtered out user ${assessmentOutputData.user_id}`);
            return false;
        } else {
            return true;
        }
    })

    const {course, rubricAssociationId, assessmentOutputDataList} = data;

    if (verbose) {
        console.log(`Uploading assessments for rubric association ${styles.bold.open}${rubricAssociationId}${styles.bold.close}...`);
    }

    for (let i = 0; i < assessmentOutputDataList.length; i++) {
        await Deno.stdout.write(new TextEncoder().encode('_'));
    }
    await Deno.stdout.write(new TextEncoder().encode('.'));
    console.log();

    const errors = []
    const results = []
    for (const assessmentOutputData of assessmentOutputDataList) {
        const url = `${canvas}/api/v1/courses/${course}/rubric_associations/${rubricAssociationId}/rubric_assessments`;

        if (verbose) console.log(url, assessmentOutputData);
        const result = dryRun ? (() => {
            const points = Object.values(assessmentOutputData).map(criteria => criteria.points || 0).reduce((a, b) => a + b);
            console.log(`Would upload assessment of ${points} points for ${assessmentOutputData.user_id}`);
            return {};
        })() : await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({rubric_assessment: <AssessmentOutputData>assessmentOutputData}),
        }).then(r => r.json());
        results.push(result);

        if (result.errors) {
            await Deno.stdout.write(new TextEncoder().encode('E'));
            // errors.push(...result.errors);
            errors.push(result);
        } else {
            if (!dryRun) await Deno.stdout.write(new TextEncoder().encode('#'));
        }
    }
    if (!dryRun) await Deno.stdout.write(new TextEncoder().encode('|'));
    console.log();

    if (verbose) console.dir(results);

    for (const error of errors) {
        console.dir(error);
    }

    console.log(`Upload finished (${errors.length} failed of ${assessmentOutputDataList.length}).`);

    return results;
}
