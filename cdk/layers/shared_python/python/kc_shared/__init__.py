"""
Code shared by the textGeneration and knowledgeBase Lambdas, shipped as one
Lambda layer (sharedPythonLayer in cdk/lib/api-stack.ts) and importable as
`kc_shared.<module>` from /opt/python. Edit it here only; there are no copies
in the Lambda packages. The crawler/transcriber images cannot use a layer and
keep their own copy of embeddings.py (containers/common), held identical by
lambda/textGeneration/tests/test_shared_module_parity.py.
"""
