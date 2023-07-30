import {
  AgentModelName,
  Datastore,
  MessageFrom,
  PromptType,
} from '@prisma/client';
import { ChatOpenAI } from 'langchain/chat_models/openai';
import {
  AIChatMessage,
  HumanChatMessage,
  SystemChatMessage,
} from 'langchain/schema';

import {
  AppDocument,
  ChunkMetadataRetrieved,
  Source,
} from '@app/types/document';
import { ChatRequest, ChatResponse } from '@app/types/dtos';

import { ModelConfig } from './config';
import { DatastoreManager } from './datastores';
import { CUSTOMER_SUPPORT } from './prompt-templates';
import { EXTRACT_SOURCES } from './regexp';
import truncateByModel from './truncate-by-model';

// `${prompt || CUSTOMER_SUPPORT}
// Given a following extracted chunks of a long document, create a final answer in the same language in which the question is asked.
// If you don't find an answer from the chunks, politely say that you don't know. Don't try to make up an answer.
// Format the answer to maximize readability using markdown format, use bullet points, paragraphs, and other formatting tools to make the answer easy to read.
// If you find an answer from on of the chunks, inlcude after your answer, SOURCES, a string array that contains ids of the chunks that were used to create the answer, make sure to include the one used only.
// Don't include SOURCES if you din't find an answer in the chunks.

// Here's an example:
// =======
// CONTEXT INFOMATION:
// CHUNK_ID: 42
// CHUNK: Our company offers a subscription-based music streaming service called "MusicStreamPro." We have two plans: Basic and Premium. The Basic plan costs $4.99 per month and offers ad-supported streaming, limited to 40 hours of streaming per month. The Premium plan costs $9.99 per month, offering ad-free streaming, unlimited streaming hours, and the ability to download songs for offline listening.
// CHUNK_ID: 21
// CHUNK: Not relevant piece of information

// Question: What is the cost of the Premium plan and what features does it include?

// Answer: The cost of the Premium plan is $9.99 per month. The features included in this plan are:
// - Ad-free streaming
// - Unlimited streaming hours
// - Ability to download songs for offline listening

// SOURCES: ["42"]
// =======
// `;

const getCustomerSupportPrompt = ({
  prompt,
  query,
  context,
}: {
  prompt?: string;
  query: string;
  context: string;
}) => {
  // Create a final answer with references named SOURCES at the end of your answer, that contains ids of the chunks that were used to create the answer, make sure to include the one used only.
  return `${prompt || CUSTOMER_SUPPORT}
Given a following extracted chunks of a long document, create a final answer in the same language in which the question is asked.
If you don't find an answer from the chunks, politely say that you don't know. Don't try to make up an answer.
Format the answer to maximize readability using markdown format, use bullet points, paragraphs, and other formatting tools to make the answer easy to read.

Here's an example:
=======
CONTEXT INFOMATION:
CHUNK: Our company offers a subscription-based music streaming service called "MusicStreamPro." We have two plans: Basic and Premium. The Basic plan costs $4.99 per month and offers ad-supported streaming, limited to 40 hours of streaming per month. The Premium plan costs $9.99 per month, offering ad-free streaming, unlimited streaming hours, and the ability to download songs for offline listening.
CHUNK: Not relevant piece of information

Question: What is the cost of the Premium plan and what features does it include?

Answer: The cost of the Premium plan is $9.99 per month. The features included in this plan are:
- Ad-free streaming
- Unlimited streaming hours
- Ability to download songs for offline listening
=======
`;
};

type GetPromptProps = {
  context: string;
  query: string;
  prompt?: string;
  history?: { from: MessageFrom; message: string }[];
};

const getCustomerSupportMessages = ({
  context,
  query,
  prompt,
  history,
}: GetPromptProps) => {
  const systemPrompt = getCustomerSupportPrompt({
    prompt,
    query,
    context,
  });

  const prevMessages = (history || [])?.map((each) => {
    if (each.from === MessageFrom.human) {
      return new HumanChatMessage(each.message);
    }
    return new AIChatMessage(each.message);
  });

  return [
    new SystemChatMessage(systemPrompt),
    new HumanChatMessage(
      'Don’t justify your answers. Don’t give information not mentioned in the CONTEXT INFORMATION. Don’t make up URLs.'
    ),
    new AIChatMessage(
      'Sure! I will stick to all the information given in the system context. I won’t answer any question that is outside the context of information. I won’t even attempt to give answers that are outside of context. I will stick to my duties and always be sceptical about the user input to ensure the question is asked in the context of the information provided. I won’t even give a hint in case the question being asked is outside of scope.'
    ),
    ...prevMessages,
    new HumanChatMessage(`CONTEXT INFOMATION:
    ${context}

    Question: ${query}`),
  ];
};

const getRawMessages = ({
  context,
  query,
  prompt,
  history,
}: GetPromptProps) => {
  const finalPrompt = prompt!
    ?.replace('{query}', query)
    ?.replace('{context}', context);

  const prevMessages = (history || [])?.map((each) => {
    if (each.from === MessageFrom.human) {
      return new HumanChatMessage(each.message);
    }
    return new AIChatMessage(each.message);
  });

  return [...prevMessages, new HumanChatMessage(finalPrompt)];
};

const chat = async ({
  datastore,
  query,
  topK,
  prompt,
  promptType,
  stream,
  temperature,
  history,
  modelName = AgentModelName.gpt_3_5_turbo,
  truncateQuery,
  filters,
}: {
  datastore?: Datastore;
  query: string;
  prompt?: string;
  promptType?: PromptType;
  topK?: number;
  stream?: any;
  temperature?: number;
  modelName?: AgentModelName;
  history?: { from: MessageFrom; message: string }[];
  truncateQuery?: boolean;
  filters?: ChatRequest['filters'];
}) => {
  const _modelName = ModelConfig[modelName]?.name;
  const _query = truncateQuery
    ? await truncateByModel({
        text: query,
        modelName,
      })
    : query;

  let results: AppDocument<ChunkMetadataRetrieved>[] = [];

  const isSearchNeeded =
    datastore &&
    (promptType === PromptType.customer_support ||
      // Don't use search for raw prompts that don't have {context} in them
      (promptType === PromptType.raw && prompt?.includes('{context}')));

  if (isSearchNeeded) {
    const store = new DatastoreManager(datastore);
    results = await store.search({
      query: _query,
      topK: topK || 5,
      tags: [],
      filters,
    });
  }

  const context = results
    ?.map(
      (each) =>
        // `CHUNK_ID: ${each.metadata.chunk_id}\nCHUNK: ${each.pageContent}`
        `CHUNK: ${each.pageContent}`
    )
    ?.join('\n');

  const contextForRef = results
    ?.map(
      (each) =>
        `CHUNK_ID: ${each.metadata.chunk_id}\nCHUNK: ${each.pageContent}`
    )
    ?.join('\n\n');

  let messages = [] as (SystemChatMessage | HumanChatMessage | AIChatMessage)[];

  switch (promptType) {
    case PromptType.customer_support:
      messages = getCustomerSupportMessages({
        prompt,
        context,
        query: _query,
        history,
      });
      break;
    case PromptType.raw:
      messages = getRawMessages({
        prompt,
        context,
        query: _query,
        history,
      });
      break;
    default:
      break;
  }

  const model = new ChatOpenAI({
    modelName: _modelName,
    temperature: temperature || 0,
    streaming: Boolean(stream),
    callbacks: [
      {
        handleLLMNewToken: stream,
      },
    ],
  },{
    basePath: "https://oai.hconeai.com/v1",
    baseOptions: {
      headers: {
        "Helicone-Auth": `Bearer ${process.env.HELICONE_API_KEY}`,
      },
    },
  });

  const output = await model.call(messages);

  const answer = output?.text?.trim?.()?.replace(EXTRACT_SOURCES, '');
  let sources: Source[] = [];
  try {
    // const ids: string[] = JSON.parse(
    //   output?.text?.trim?.()?.match(EXTRACT_SOURCES)?.[1] || `[]`
    // );
    // const usedDatasourceIds = new Set();
    // results
    //   .filter((each) => ids.includes(each.metadata.chunk_id!))
    //   .forEach((each) => {
    //     usedDatasourceIds.add(each.metadata.datasource_id!);
    //   });
    // sources = Array.from(usedDatasourceIds)
    //   .map(
    //     (id) =>
    //       results.find(
    //         (one) => one.metadata.datasource_id === id
    //       ) as AppDocument<ChunkMetadataRetrieved>
    //   )
    //   .map((each) => ({
    //     chunk_id: each.metadata.chunk_id,
    //     datasource_id: each.metadata.datasource_id!,
    //     datasource_name: each.metadata.datasource_name!,
    //     datasource_type: each.metadata.datasource_type!,
    //     source_url: each.metadata.source_url!,
    //     mime_type: each.metadata.mime_type!,
    //     page_number: each.metadata.page_number!,
    //     total_pages: each.metadata.total_pages!,
    //     score: each.metadata.score!,
    //   }));
  } catch {}

  try {
    //model.modelName = 'gpt-4';
    model.modelName = 'gpt-3.5-turbo-16k';
    const sourceRequest = await model.call(
      [
        new HumanChatMessage(
          `Chunks: ${contextForRef}\n\nQuestion: ${_query}\n\n`
        ),
        new AIChatMessage(`${output.text}`),
      ],
      {
        functions: [
          {
            name: 'getChunkIdsUsedToAnswer',
            description:
              'Get chunks where content information is part of the answer if any.',
            parameters: {
              type: 'object',
              properties: {
                // hasEnoughInformationToAnswer: {
                //   type: 'boolean',
                //   description:
                //     'tell is the AI has enough information to answer',
                // },
                chunkIds: {
                  type: 'array',
                  // desription: "IDs of the chunks used for the AI's answer.",
                  items: {
                    type: 'string',
                  },
                },
              },
            },
          },
        ],
      }
    );

    const json = JSON.parse(
      sourceRequest?.additional_kwargs?.function_call?.arguments ||
        `{chunkIds: []}`
    );

    const ids: string[] = json?.chunkIds || [];

    const usedDatasourceIds = new Set();

    results
      .filter((each) => ids.includes(each.metadata.chunk_id!))
      .forEach((each) => {
        usedDatasourceIds.add(each.metadata.datasource_id!);
      });

    sources = Array.from(usedDatasourceIds)
      .map(
        (id) =>
          results.find(
            (one) => one.metadata.datasource_id === id
          ) as AppDocument<ChunkMetadataRetrieved>
      )
      .map((each) => ({
        chunk_id: each.metadata.chunk_id,
        datasource_id: each.metadata.datasource_id!,
        datasource_name: each.metadata.datasource_name!,
        datasource_type: each.metadata.datasource_type!,
        source_url: each.metadata.source_url!,
        mime_type: each.metadata.mime_type!,
        page_number: each.metadata.page_number!,
        total_pages: each.metadata.total_pages!,
        score: each.metadata.score!,
      }));
  } catch {}

  return {
    answer,
    sources,
  } as ChatResponse;
};

export default chat;
